var
  liquidPID = require('liquid-pid'),
  actualP = 0,
  pidController;

var max31855 = require('max31855');
var thermoSensor = new max31855();
var actualTemp = 0;
var WindowSize = 5000;
var tempHoldTime = 60; // in minutes
var tempHitTime;

pidController = new liquidPID({
  temp: {
    ref: 30         // Point temperature                                       
  },
  Pmax: WindowSize,       // Max power (output) [Window Size]
  
  // Tune the PID Controller
  Kp: 25,           // PID: Kp
  Ki: 1000,         // PID: Ki
  Kd: 9             // PID: Kd
});

var windowStartTime = new Date().getTime();
var i = 0;

console.log('Target temp:', pidController.getRefTemperature());

function pid() {
  thermoSensor.readTempC(function(temp) {
        actualTemp = temp;
        console.log('Temp in degrees celsius: %s, in farenheight: %s', temp, temp * 9/5 + 32);

        actualP = pidController.calculate(actualTemp);	// call with the actual temp
        console.log('Actual p: ', actualP);

        var now = new Date().getTime();
    
        if ((now - windowStartTime) > WindowSize) {
            // time to shift the Relay Window
            windowStartTime += WindowSize;
        }
        if (actualP > (now - windowStartTime)) {
            //digitalWrite(RelayPin,HIGH);
            console.log('Now: %s, Turn Relay ON', now);
        }
        else {
            //digitalWrite(RelayPin,LOW);
            console.log('Now %s, Turn Relay OFF', now);
        }
        
        i++;

        if (i < 10) {
          pid();
        }
    });
}

// kick off the pid
pid();
