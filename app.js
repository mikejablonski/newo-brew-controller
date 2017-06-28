// usage
// node app.js <BrewSessionName> <TargetTempInDegC> <TempHoldTime>
// example:
// sudo node app.js IPA1 68 60

var liquidPID = require('liquid-pid');
var actualP = 0;
var pidController;

const winston = require('winston');
const fs = require('fs');
const env = process.env.NODE_ENV || 'development';
const logDir = 'logs';
// Create the log directory if it does not exist
if (!fs.existsSync(logDir)) {
  fs.mkdirSync(logDir);
}
const tsFormat = () => (new Date()).toLocaleTimeString();
const logger = new (winston.Logger)({
  transports: [
    // colorize the output to the console
    new (winston.transports.Console)({
      timestamp: tsFormat,
      colorize: true,
      level: 'info'
    }),
    new (winston.transports.File)({
      filename: `${logDir}/session.log`,
      timestamp: tsFormat,
      level: env === 'development' ? 'debug' : 'info'
    })
  ]
});

// read the command line args
if (process.argv.length < 5) {
  console.log("Usage: sudo node app.js <BrewSessionName> <TargetTemp> <TempHoldTime>");
  process.exit();
}
var brewSessionName = process.argv[2];  // the brew session name
var targetTemp = process.argv[3];       // pid target temp
var tempHoldTime = process.argv[4];     // time in minutes we hold temp for
var brewSession;

var loki = require('lokijs');
var db = new loki('brewSessions.json', 
      {
        autoload: true,
        autoloadCallback : loadHandler,
        autosave: true, 
        autosaveInterval: 10000 // 10 seconds
      });
var brewSessionCollection;

var dateFormat = require('dateformat');
var Gpio = require('onoff').Gpio;
var pinGpioNumHeat = 5;
var pinGpioNumPump = 6;
var actualTemp = 0;
var WindowSize = 5000;

var exec = require('child-process-promise').exec;

var tempHitTime;        // time when we hit the mash temp
var tempStopTime;       // time when we turn off the heat
var prevLogTime;        // previous logged timestamp in the pid loop

var logTimeSpan = 30000; // time between log entries in ms

pidController = new liquidPID({
  temp: {
    ref: targetTemp     // Point temperature                                       
  },
  Pmax: WindowSize, // Max power (output) [Window Size]
  
  // Tune the PID Controller
  Kp: 25,           // PID: Kp
  Ki: 1000,         // PID: Ki
  Kd: 9             // PID: Kd
});

var relayHeat = new Gpio(pinGpioNumHeat, 'out'); // uses "GPIO" numbering
var relayPump = new Gpio(pinGpioNumPump, 'out'); // uses "GPIO" numbering
var windowStartTime = new Date().getTime();
var readVal;            // value read from the probe
var prevTemp = 0;       // keep track of the previous temp reading in case of errors from the probe
var hasHitTemp = false; // have we hit our temp yet?
var relayStatus = '';

function pid() {
  exec('python ../MAX31865/max31865.py')
    .then(function (result) {
      var stdout = result.stdout;
      var stderr = result.stderr;
            
      tempSensor.degreesC = Number(stdout).toFixed(2);

      actualTemp = temp;
      if (isNaN(actualTemp)) {
        actualTemp = prevTemp;
      }
      else {
        prevTemp = actualTemp;
      }

      // get the "power" value from the pid logic
      actualP = pidController.calculate(actualTemp);	// call with the actual temp
      var now = new Date().getTime();
      
      if (!hasHitTemp && (actualTemp >= pidController.getRefTemperature())) {
        hasHitTemp = true;
        tempHitTime = now;
        tempStopTime = new Date(tempHitTime + tempHoldTime * 60000);
        
        // log the mash start to the database
        brewSession.mashStartTime = tempHitTime;
        brewSession.formattedMashStartTime = dateFormat(tempHitTime, "hh:MM:ss TT");
        brewSessionCollection.update(brewSession);
        db.saveDatabase(function(err) {
          logger.info('Save database completed. Mash start time.');
          if (err) {
            logger.error('Save database error.', {error: err})
          }
        });
      }

      //logger.verbose("Now-windowStartTime: %s, WindowSize: %s, actualP: %s, relay: %s", now - windowStartTime, WindowSize, actualP, relayStatus);

      if ((now - windowStartTime) > WindowSize) {
        // time to shift the Relay Window
        logger.verbose("Shift relay window.");
        windowStartTime += WindowSize;
      }
      
      // changed to >= to try and prevent flipping while initially heating
      if (actualP >= (now - windowStartTime)) {
          readVal = relayHeat.readSync();
          if (readVal == 1) {
            relayHeat.writeSync(0); // 0 is on, 1 is off
            logger.verbose("Turning heat on. Now-windowStartTime: %s, WindowSize: %s, actualP: %s", now - windowStartTime, WindowSize, actualP);
          }
          relayStatus = "ON ";
      }
      else {
          readVal = relayHeat.readSync();
          if (readVal == 0) {
            relayHeat.writeSync(1); // 0 is on, 1 is off
            logger.verbose("Turning heat off. Now-windowStartTime: %s, WindowSize: %s, actualP: %s", now - windowStartTime, WindowSize, actualP);
          }
          relayStatus = "OFF";
      }

      // check if we need to log this temp to the database for this brew session
      // and output to the console
      // TODO: Check if changing this to >= fixes logging bug.
      if (!prevLogTime || (now - prevLogTime >= logTimeSpan)) {
        // log this temp in the database
        var logDate = new Date().getTime();
        brewSession.mashTempData.push(
          {
            time: logDate,
            formattedTime: dateFormat(logDate, "hh:MM:ss TT"),
            tempC: Math.round(actualTemp * 100) / 100,
            tempF: Math.round((actualTemp * 9/5 + 32) * 100) / 100
          }
        );
        brewSessionCollection.update(brewSession);
        db.saveDatabase(function(err) {
          logger.info('Save database completed.');
          if (err) {
            logger.error('Save database error.', {error: err})
          }
        });
        prevLogTime = now;

        logger.info('Target:%s, Temp C:%s, Temp F:%s, ActualP:%s, Relay:%s, Temp Hit:%s, Temp Hold:%s min, Now:%s, Stop:%s',
          Number(pidController.getRefTemperature()).toFixed(2),
          Number(actualTemp).toFixed(2),
          Number(actualTemp * 9/5 + 32).toFixed(2),
          actualP,
          relayStatus,
          tempHitTime ? dateFormat(tempHitTime, "hh:MM:ss:L TT") : "TBD",
          tempHoldTime,
          dateFormat(now, "hh:MM:ss:L TT"),
          tempStopTime ? dateFormat(tempStopTime, "hh:MM:ss:L TT"): "TBD");
      }

      // keep calling pid until we hit our temp hold time
      if (!tempHitTime || (tempHitTime + tempHoldTime * 60000) > now) {
        pid();
      }
      else {
        logger.info("Mash complete. Running cleanup.")

        // log the mash end to the database
        var logDate = new Date().getTime();
        brewSession.mashEndTime = logDate;
        brewSession.formattedMashEndTime = dateFormat(logDate, "hh:MM:ss TT");
        brewSessionCollection.update(brewSession);
        db.saveDatabase(function(err) {
          logger.info('Save database completed. Mash end time.');
          if (err) {
            logger.error('Save database error.', {error: err})
          }
        });

        cleanUp();
      }
    }); // end of exec python then
}

function cleanUp() {
  logger.info('Cleaning up...');

  // close the database
  db.close();

  // turn off the heater
  readVal = relayHeat.readSync();
  if (readVal == 0) {
    relayHeat.writeSync(1); // 0 is on, 1 is off
    logger.verbose("Turn off heater.");
  }
  
  // turn off the pump
  readVal = relayPump.readSync();
  if (readVal == 0) {
    relayPump.writeSync(1); // 0 is on, 1 is off
    logger.verbose("Turn off pump.");
  }
}

function loadHandler() {
    logger.info("Starting session for %s.", brewSessionName);

    // if database did not exist it will be empty so I will intitialize here
    brewSessionCollection = db.getCollection('brewSessions');
    if (brewSessionCollection === null) {
        brewSessionCollection = db.addCollection('brewSessions');
    }

    // check if the brewSession already exists
    brewSession = brewSessionCollection.findOne( {'name': brewSessionName} );
    if (!brewSession) {
      var createdDate = new Date().getTime();
      brewSession = {
        'name': brewSessionName,
        'created': createdDate,
        'formattedCreated': dateFormat(createdDate, "mm-dd-yyyy"),
        'mashStartTime': '',
        'formattedMashStartTime': '',
        'mashEndTime': '',
        'formattedMashEndTime': '',
        'mashHoldTime': tempHoldTime,
        'mashTemp': targetTemp,
        'mashTempData': [],
      };
      brewSessionCollection.insert(brewSession);
      db.saveDatabase(function(err) {
        logger.info('Save database completed.');
        if (err) {
          logger.error('Save database error.', {error: err})
        }
      });
    }

    // turn on the pump
    readVal = relayPump.readSync();
    if (readVal == 0) {
      relayPump.writeSync(0); // 0 is on, 1 is off
      logger.verbose("Turn on pump.");
    }

    // kick off the pid
    pid();
}

// handle ctrl-c exit
process.on('SIGINT', function() {
    logger.verbose("Received SIGINT. cleaning up before exit.");
    cleanUp();
    process.exit(0);
});

// handle kill process
process.on('SIGTERM', function() {
    logger.verbose("Received SIGTERM. cleaning up before exit.");
    cleanUp();
    process.exit(0);
});