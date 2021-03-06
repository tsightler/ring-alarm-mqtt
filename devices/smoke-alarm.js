const debug = require('debug')('ring-mqtt')
const utils = require( '../lib/utils' )
const AlarmDevice = require('./alarm-device')

class SmokeAlarm extends AlarmDevice {
    constructor(deviceInfo) {
        super(deviceInfo)

        // Home Assistant component type and device class (set appropriate icon)
        this.component = 'binary_sensor'
        this.className = 'smoke'

        // Device data for Home Assistant device registry
        this.deviceData.mdl = 'Smoke Alarm'

        // Build required MQTT topics
        this.stateTopic = this.deviceTopic+'/smoke/state'
        this.configTopic = 'homeassistant/'+this.component+'/'+this.locationId+'/'+this.deviceId+'/config'        
    }
        
    initDiscoveryData() {
        // Build the MQTT discovery message
        this.discoveryData.push({
            message: {
                name: this.device.name,
                unique_id: this.deviceId,
                availability_topic: this.availabilityTopic,
                payload_available: 'online',
                payload_not_available: 'offline',
                state_topic: this.stateTopic,
                device_class: this.className,
                device: this.deviceData
            },
            configTopic: this.configTopic
        })
        
        this.initInfoDiscoveryData()
    }

    publishData() {
        const smokeState = this.device.data.alarmStatus === 'active' ? 'ON' : 'OFF'
        // Publish device sensor state
        this.publishMqtt(this.stateTopic, smokeState, true)
        // Publish device attributes (batterylevel, tamper status)
        this.publishAttributes()
    }
}

module.exports = SmokeAlarm
