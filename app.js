// usage
// node app.js <BrewSessionName> <TargetTemp>
// example:
// sudo node app.js IPA1 155

var liquidPID = require('liquid-pid'),
var actualP = 0;
var pidController;

// read the command line args
if (process.argv.length < 4) {
  console.log("Usage: sudo node app.js <BrewSessionName> <TargetTemp>");
  process.exit();
}
var brewSessionName = process.argv[2];  // the brew session name
var tempHoldTime = process.argv[3];     // time in minutes we hold temp for
var brewSession;

var loki = require('lokijs');
var db = new loki('brewSessions.json', 
      {
        autoload: true,
        autoloadCallback : loadHandler,
        autosave: true, 
        autosaveInterval: 10000 // 10 seconds
      });

var dateFormat = require('dateformat');
var Gpio = require('onoff').Gpio;
var pinGpioNumHeat = 13;
var max31855 = require('max31855');
var thermoSensor = new max31855();
var actualTemp = 0;
var WindowSize = 5000;

var tempHitTime;        // time when we hit the mash temp
var tempStopTime;       // time when we turn off the heat
var prevLogTime;        // previous logged timestamp in the pid loop

var logTimeSpan = 5000; // time between log entries in ms

pidController = new liquidPID({
  temp: {
    ref: 23         // Point temperature                                       
  },
  Pmax: WindowSize, // Max power (output) [Window Size]
  
  // Tune the PID Controller
  Kp: 25,           // PID: Kp
  Ki: 1000,         // PID: Ki
  Kd: 9             // PID: Kd
});

var relayHeat = new Gpio(pinGpioNumHeat, 'out'); // uses "GPIO" numbering
var windowStartTime = new Date().getTime();
var readVal;            // value read from the probe
var prevTemp = 0;       // keep track of the previous temp reading in case of errors from the probe
var hasHitTemp = false; // have we hit our temp yet?
var relayStatus = '';

function pid() {
  thermoSensor.readTempC(function(temp) {
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
        
        // check if we need to log this temp to the database for this brew session
        if (!prevLogTime || (now - prevLogTime == logTimeSpan)) {
          // log this temp in the database
          brewSession.mashTempData.push(
            {time: new Date().getTime(), temp: actualTemp}
          );
          prevLogTime = now;
        }
        
        if (!hasHitTemp && (actualTemp >= pidController.getRefTemperature())) {
          hasHitTemp = true;
          tempHitTime = now;
          tempStopTime = new Date(tempHitTime + tempHoldTime * 60000);
        }

        if ((now - windowStartTime) > WindowSize) {
            // time to shift the Relay Window
            windowStartTime += WindowSize;
        }
        
        if (actualP > (now - windowStartTime)) {
            readVal = relayHeat.readSync();
            if (readVal == 1) {
              relayHeat.writeSync(0); // 0 is on, 1 is off
            }
            relayStatus = "ON ";
        }
        else {
            readVal = relayHeat.readSync();
            if (readVal == 0) {
              relayHeat.writeSync(1); // 0 is on, 1 is off
            }
            relayStatus = "OFF";
        }

        console.log('Target:%s, Temp C:%s, Temp F:%s, ActualP:%s, Relay:%s, Temp Hit:%s, Temp Hold:%s min, Now:%s, Stop:%s',
          Number(pidController.getRefTemperature()).toFixed(2),
          Number(actualTemp).toFixed(2),
          Number(actualTemp * 9/5 + 32).toFixed(2),
          actualP,
          relayStatus,
          tempHitTime ? dateFormat(tempHitTime, "hh:MM:ss:L TT") : "TBD",
          tempHoldTime,
          dateFormat(now, "hh:MM:ss:L TT"),
          tempStopTime ? dateFormat(tempStopTime, "hh:MM:ss:L TT"): "TBD");

        // keep calling pid until we hit our temp hold time
        if (!tempHitTime || (tempHitTime + tempHoldTime * 60000) > now) {
          pid();
        }
        else {
          cleanUp();
        }
    });
}

function cleanUp() {
  console.log('Cleaning up...');
}

function loadHandler() {
    // if database did not exist it will be empty so I will intitialize here
    var coll = db.getCollection('brewSessions');
    if (coll === null) {
        coll = db.addCollection('brewSessions');
    }

    var brewSession = coll.findOne( {'name': brewSessionName} );
    if (!brewSession) {
      brewSession = {
        'name': brewSessionName,
        'created': new Date().getTime(),
        'mashStartTime': '',
        'mashEndTime': '',
        'mashTemp': tempHoldTime,
        'mashTempData': [
          {}
        ],
      };
    }

    // kick off the pid
    pid();
}

