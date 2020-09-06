const debug = require('debug')('ring-mqtt')
const utils = require( '../lib/utils' )
const AlarmDevice = require('./alarm-device')

class BaseStation extends AlarmDevice {
    async publish(locationConnected) {
        // Only publish if location websocket is connected
        if (!locationConnected) { return }

        // If this is the very first publish for this device (device is not yet subscribed)
        // check if account has access set volume and, if so, enable volume control
        if (!this.subscribed) {
            const origVolume = (this.device.data.volume && !isNaN(this.device.data.volume) ? this.device.data.volume : 0)
            const testVolume = (origVolume === 1) ? .99 : origVolume+.01
            this.device.setVolume(testVolume)
            await utils.sleep(1)
            if (this.device.data.volume === testVolume) {
                debug('Account has access to set volume on base station, enabling volume control')
                this.device.setVolume(origVolume)
                this.setVolume = true
            } else {
                debug('Account does not have access to set volume on base station, disabling volume control')
                this.setVolume = false
            }
        }

        // Device data for Home Assistant device registry
        this.deviceData.mdl = 'Alarm Base Station'
        this.deviceData.name = this.device.location.name + ' Base Station'

        if (this.setVolume) {
            // Build required MQTT topics
            this.stateTopic_audio = this.deviceTopic+'/audio/state'
            this.commandTopic_audio = this.deviceTopic+'/audio/command'
            this.stateTopic_audio_volume = this.deviceTopic+'/audio/volume_state'
            this.commandTopic_audio_volume = this.deviceTopic+'/audio/volume_command'
            this.configTopic_audio = 'homeassistant/light/'+this.locationId+'/'+this.deviceId+'_audio/config'
        }

        // Publish discovery message
        if (!this.discoveryData.length) { await this.initDiscoveryData() }
        await this.publishDiscoveryData()

        // Publish device state data with optional subscribe
        this.publishSubscribeDevice()

        if (this.setVolume) {
            // Subscribe to device command topics
            this.mqttClient.subscribe(this.commandTopic_audio)
            this.mqttClient.subscribe(this.commandTopic_audio_volume)
        }
    }

    initDiscoveryData() {
        if (this.setVolume) {
            // Build the MQTT discovery messages
            this.discoveryData.push({
                message: {
                    name: this.device.name+' Audio Settings',
                    unique_id: this.deviceId+'_audio',
                    availability_topic: this.availabilityTopic,
                    payload_available: 'online',
                    payload_not_available: 'offline',
                    state_topic: this.stateTopic_audio,
                    command_topic: this.commandTopic_audio,
                    brightness_scale: 100,
                    brightness_state_topic: this.stateTopic_audio_volume,
                    brightness_command_topic: this.commandTopic_audio_volume,
                    device: this.deviceData
                },
                configTopic: this.configTopic_audio
            })
        }

        // Device has no sensors, only publish info data
        this.initInfoDiscoveryData('acStatus')
    }

    publishData() {
        if (this.setVolume) {
            // Publish volume state to switch entity
            const audioVolume = (this.device.data.volume && !isNaN(this.device.data.volume) ? Math.round(100 * this.device.data.volume) : 0)
            const audioState = (audioVolume > 0) ? "ON" : "OFF"
            this.publishMqtt(this.stateTopic_audio, audioState, true)
            this.publishMqtt(this.stateTopic_audio_volume, audioVolume.toString(), true)
        }

        // Publish device attributes (batterylevel, tamper status)
        this.publishAttributes()
    }

    // Process messages from MQTT command topic
    processCommand(message, topic) {
        if (topic == this.commandTopic_audio) {
            this.setAudioState(message)
        } else if (topic == this.commandTopic_audio_volume) {
            this.setVolumeLevel(message)
        } else {
            debug('Somehow received unknown command topic '+topic+' for keypad Id: '+this.deviceId)
        }
    }

    // Set switch target state on received MQTT command message
    setAudioState(message) {
        const audioVolume = (this.device.data.volume && !isNaN(this.device.data.volume) ? Math.round(100 * this.device.data.volume) : 0)
        const audioState = (audioVolume > 0) ? "ON" : "OFF"
        const command = message.toUpperCase()
        switch(command) {
            case 'ON':
            case 'OFF': {
                if (command !== audioState) {
                    debug('Received command to turn '+command+' audio for base station Id: '+this.deviceId)
                    const volume = (command === 'on') ? .65 : 0
                    debug('Setting volume level to '+volume*100+'%')
                    this.device.setVolume(volume)
                }
                break;
            }
            default:
                debug('Received invalid audio command for keypad!')
        }
    }

    // Set switch target state on received MQTT command message
    setVolumeLevel(message) {
        const volume = message
        debug('Received set volume level to '+volume+'% for base station Id: '+this.deviceId)
        debug('Location Id: '+ this.locationId)
        if (isNaN(message)) {
                debug('Volume command received but not a number!')
        } else if (!(message >= 0 && message <= 100)) {
            debug('Volume command received but out of range (0-100)!')
        } else {
            this.device.setVolume(volume/100)
        }
    }

}

module.exports = BaseStation