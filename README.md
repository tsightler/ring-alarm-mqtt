# ring-alarm-mqtt
This is a simple script that leverages the ring alarm API available at [dgreif/ring-alarm](https://github.com/dgreif/ring-alarm) and providing access to the alarm sensors and control panel via MQTT.  It provides support for Home Assistant style MQTT discovery which allows for very easy integration with Home Assistant with near zero configuration (assuming MQTT is already configured).  It can also be used with any other tool capable of working with MQTT as it provides consistent topic naming based on location/device ID.

### Installation
Make sure NodeJS is installed on your system then clone this repo:

`git clone https://github.com/tsightler/ring-alarm-mqtt.git`

Change to created ring-alarm-mqtt and run:

```
chmod +x ring-alarm-mqtt.js
npm install
```

This should install all required dependencies.  Edit the config.js and enter your Ring account user/password and MQTT broker connection information.  You can also change the top level topic used for creating ring device topics and also configre the Home Assistant state topic, but most people should leave these as default.

Now you should just be able to run the script

**TODO: Include a simple start/stop script**

### Optional Home Assistant Configuration
If you'd like to take advantage of the Home Assistant specific features (auto MQTT discovery and state monitorting) you need to make sure Home Assistant MQTT is configured, here's an example:
```
mqtt:
  broker: 127.0.0.1
  discovery: true
  discovery_prefix: homeassistant
  birth_message:
    topic: 'hass/status'
    payload: 'online'
    qos: 0
    retain: false
```

### Current Features
- Simple configuration via config file
- Home Assistant MQTT Discovery (also tested with OpenHAB 2.4)
- Consistent topic creation based on location/device ID
- Arm/Disarm via alarm control panel MQTT object
- Arm/Disarm commands are monitored for success and retried (default up to 12x with 10 second interval)
- Contact Sensors
- Motion Sensors
- Multiple alarm support
- Monitors websocket connection to each alarm and sets reachability status of socket is unavailable, resends config when connection is established
- Can monitor Home Assistant MQTT birth message to trigger automatic resend of configuration data when Home Assistant restarts (sends config 30 seconds after receiving online MQTT birth message from Home Assistant)
- Monitors MQTT connection and resends status after any reconnect
- Does not require retain and can work well with MQTT brokers that provide no persistence

### Planned Features
- Additional devices (Fire/CO2/Flood)
- Battery status for devices
- Tamper status

### Possible future features
- Base station settings (volume, chime)
- Support for camera motion/lights/siren
- Arm/Disarm with code
- Arm/Disarm with sensor bypass
- Dynamic add/remove of alarms/devices

### Debugging
By default the script should produce no console output, however, the script does leverage the terriffic [debug](https://www.npmjs.com/package/debug) package.  To get debug, simply run the script like this:

**Debug messages from all modules**
```
DEBUG=* ./ring-alarm-mqtt.js
````

**Debug messages from ring-alarm-mqtt onlY**
```
DEBUG=ring-alarm-mqtt ./ring-alarm-mqtt.js
```
