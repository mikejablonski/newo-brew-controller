var
  liquidPID = require('liquid-pid'),
  actualP = 0,
  pidController;

var Gpio = require('onoff').Gpio;
var pinGpioNumHeat = 13;
var dateFormat = require('dateformat');
var max31855 = require('max31855');
var thermoSensor = new max31855();
var actualTemp = 0;
var WindowSize = 5000;
var tempHoldTime = 5; // in minutes
var tempHitTime;
var tempStopTime;

pidController = new liquidPID({
  temp: {
    ref: 23         // Point temperature                                       
  },
  Pmax: WindowSize,       // Max power (output) [Window Size]
  
  // Tune the PID Controller
  Kp: 25,           // PID: Kp
  Ki: 1000,         // PID: Ki
  Kd: 9             // PID: Kd
});

var relayHeat = new Gpio(pinGpioNumHeat, 'out'); // uses "GPIO" numbering
var windowStartTime = new Date().getTime();
var readVal;
var prevTemp = 0;
var hasHitTemp = false;

console.log('Target temp:', pidController.getRefTemperature());

function pid() {
  thermoSensor.readTempC(function(temp) {
        actualTemp = temp;
        if (isNaN(actualTemp)) {
          actualTemp = prevTemp;
        }
        else {
          prevTemp = actualTemp;
        }
        //console.log('Temp in degrees celsius: %s, in farenheight: %s', temp, temp * 9/5 + 32);

        actualP = pidController.calculate(actualTemp);	// call with the actual temp
        //console.log('Actual p: ', actualP);

        var now = new Date().getTime();
        var relayStatus = '';
        
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
            //relayHeat.write(0, relayWriteComplete); // 0 is on, 1 is off
            readVal = relayHeat.readSync();
            if (readVal == 1) {
              relayHeat.writeSync(0); // 0 is on, 1 is off
            }
            relayStatus = "ON ";
            //console.log('Now: %s, Set Relay ON', now);
        }
        else {
            //relayHeat.write(1, relayWriteComplete); // 0 is on, 1 is off
            readVal = relayHeat.readSync();
            if (readVal == 0) {
              relayHeat.writeSync(1); // 0 is on, 1 is off
            }
            relayStatus = "OFF";
            //console.log('Now %s, Set Relay OFF', now);
        }

        //console.log('Temp Hit Time: %s, Temp Hold Time: %s', tempHitTime, tempHoldTime * 60000);

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
    });
}

function relayWriteComplete(data) {
  console.log('Write complete: %s', data)
}

// kick off the pid
pid();

