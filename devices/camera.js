const debug = require('debug')('ring-mqtt')
const utils = require( '../lib/utils' )
const clientApi = require('../node_modules/ring-client-api/lib/api/rest-client').clientApi
const path = require('path')
const pathToFfmpeg = require('ffmpeg-for-homebridge');
const spawn = require('await-spawn')
const fs = require('fs');

class Camera {
    constructor(deviceInfo) {
        // Set default properties for camera device object model 
        this.camera = deviceInfo.device
        this.mqttClient = deviceInfo.mqttClient
        this.subscribed = false
        this.availabilityState = 'init'
        this.heartbeat = 3
        this.locationId = this.camera.data.location_id
        this.deviceId = this.camera.data.device_id
        this.config = deviceInfo.CONFIG
        this.snapshotMotion = false
        this.snapshotInterval = false
        this.snapshotAutoInterval = false

        // If snapshot capture is enabled, set approprate values
        if (this.config.snapshot_mode === "motion" || this.config.snapshot_mode === "interval" || this.config.snapshot_mode === "all" ) {
            this.snapshot = { imageData: null, timestamp: null, updating: false }
            this.snapshotMotion = (this.config.snapshot_mode === "motion" || this.config.snapshot_mode === "all") ? true : false

            if (this.config.snapshot_mode === "interval" || this.config.snapshot_mode === "all") {
                if (this.camera.operatingOnBattery) {
                    this.snapshotAutoInterval = true
                    if (this.camera.data.settings.hasOwnProperty('lite_24x7') && this.camera.data.settings.lite_24x7.enabled) {
                        this.snapshotInterval = this.camera.data.settings.lite_24x7.frequency_secs
                    } else {
                        this.snapshotInterval = 600
                    }
                } else {
                    this.snapshotInterval = 30
                }
            }
        }

        // Sevice data for Home Assistant device registry 
        this.deviceData = { 
            ids: [ this.deviceId ],
            name: this.camera.name,
            mf: 'Ring',
            mdl: this.camera.model
        }

        // Set device location and top level MQTT topics
        this.cameraTopic = deviceInfo.CONFIG.ring_topic+'/'+this.locationId+'/camera/'+this.deviceId
        this.availabilityTopic = this.cameraTopic+'/status'
      
        // Create properties to store motion ding state
        this.motion = {
            active_ding: false,
            ding_duration: 180,
            last_ding: 0,
            last_ding_expires: 0,
            last_ding_time: 'none',
            is_person: false
        }

        if (this.camera.isDoorbot) {
            this.ding = {
                active_ding: false,
                ding_duration: 180,
                last_ding: 0,
                last_ding_expires: 0,
                last_ding_time: 'none'
            }
        }

        // Properties to store published MQTT state
        // Used to keep from sending state updates on every poll (20 seconds)
        if (this.camera.hasLight) {
            this.publishedLightState = 'unknown'
        }

        if (this.camera.hasSiren) {
            this.publishedSirenState = 'unknown'
        }

    }

    // Publish camera capabilities and state and subscribe to events
    async publish() {
        const debugMsg = (this.availabilityState === 'init') ? 'Publishing new ' : 'Republishing existing '
        debug(debugMsg+'device id: '+this.deviceId)

        // Publish motion sensor feature for camera
        this.publishCapability({
            type: 'motion',
            component: 'binary_sensor',
            className: 'motion',
            suffix: 'Motion',
            attributes: true,
            command: false
        })

        // If doorbell publish doorbell sensor
        if (this.camera.isDoorbot) {
            this.publishCapability({
                type: 'ding',
                component: 'binary_sensor',
                className: 'occupancy',
                suffix: 'Ding',
                attributes: true,
                command: false
            })
        }

        // If camera has a light publish light component
        if (this.camera.hasLight) {
            this.publishCapability({
                type: 'light',
                component: 'light',
                suffix: 'Light',
                attributes: false,
                command: 'command'
            })
        }

        // If camera has a siren publish switch component
        if (this.camera.hasSiren) {
            this.publishCapability({
                type: 'siren',
                component: 'switch',
                suffix: 'Siren',
                attributes: false,
                command: 'command'
            })
        }

        // Publish info sensor for camera
        this.publishCapability({
            type: 'info',
            component: 'sensor',
            suffix: 'Info',
            attributes: false,
            command: false
        })

        // If snapshots enabled, publish snapshot capability
        if (this.snapshotMotion || this.snapshotInterval) {
            this.publishCapability({
                type: 'snapshot',
                component: 'camera',
                suffix: 'Snapshot',
                attributes: true,
                command: 'interval'
            })
        }
        
        // Give Home Assistant time to configure device before sending first state data
        await utils.sleep(2)

        // Publish device state and, if new device, subscribe for state updates
        if (!this.subscribed) {
            this.subscribed = true

            // Update properties with most recent historical event data
            const lastMotionEvent = (await this.camera.getEvents({ limit: 1, kind: 'motion'})).events[0]
            const lastMotionDate = (lastMotionEvent && lastMotionEvent.hasOwnProperty('created_at')) ? new Date(lastMotionEvent.created_at) : false
            this.motion.last_ding = lastMotionDate ? lastMotionDate/1000 : 0
            this.motion.last_ding_time = lastMotionDate ? lastMotionDate.toISOString() : 'none'
            this.motion.is_person = (() => {
                if (lastMotionEvent && lastMotionEvent.hasOwnProperty('cv_properties')) {
                    return lastMotionEvent.cv_properties.detection_type === 'human' ? true : false
                }
                return false
            })

            // If doorbell create properties to store doorbell ding state and get most recent event
            if (this.camera.isDoorbot) {
                const lastDingEvent = (await this.camera.getEvents({ limit: 1, kind: 'ding'})).events[0]
                const lastDingDate = (lastDingEvent && lastDingEvent.hasOwnProperty('created_at')) ? new Date(lastDingEvent.created_at) : false
                this.ding.last_ding = lastDingDate ? lastDingDate/1000 : 0,
                this.ding.last_ding_time = lastDingDate ? lastDingDate.toISOString() : 'none'
            }

            // Subscribe to Ding events (all cameras have at least motion events)
            this.camera.onNewDing.subscribe(ding => {
                this.processDing(ding)
            })

            // Since this is initial publish of device publish current ding state as well
            this.processDing()

            // Subscribe to poll events, default every 20 seconds
            this.camera.onData.subscribe(() => {
                this.publishPolledState()
                
                // Update snapshot frequency in case it's changed
                if (this.snapshotAutoInterval && this.camera.data.settings.hasOwnProperty('lite_24x7')) {
                    this.snapshotInterval = this.camera.data.settings.lite_24x7.frequency_secs
                }
            })

            // Publish snapshot if enabled
            if (this.snapshotMotion || this.snapshotInterval) {
                this.publishSnapshot(true)
                // If interval based snapshots are enabled, start snapshot refresh loop
                if (this.snapshotInterval) {
                    this.scheduleSnapshotRefresh()
                }
            }

            // Start monitor of availability state for camera
            this.monitorCameraConnection()
        } else {
            // Pulish all data states and availability state for camera
            this.processDing()

            if (this.camera.hasLight || this.camera.hasSiren) {
                if (this.camera.hasLight) { this.publishedLightState = 'republish' }
                if (this.camera.hasSiren) { this.publishedSirenState = 'republish' }
                this.publishPolledState()
            }

            // Publish snapshot image if any snapshot option is enabled
            if (this.snapshotMotion || this.snapshotInterval) {
                this.publishSnapshot()
            }     

            this.publishInfoState()
            this.publishAvailabilityState()
        }
    }

    // Publish state messages via MQTT with optional debug
    publishMqtt(topic, message, enableDebug) {
        if (enableDebug) { debug(topic, message) }
        this.mqttClient.publish(topic, message, { qos: 1 })
    }

    // Build and publish a Home Assistant MQTT discovery packet for camera capability
    async publishCapability(capability) {
        const componentTopic = this.cameraTopic+'/'+capability.type
        const configTopic = 'homeassistant/'+capability.component+'/'+this.locationId+'/'+this.deviceId+'_'+capability.type+'/config'

        const message = {
            name: this.camera.name+' '+capability.suffix,
            unique_id: this.deviceId+'_'+capability.type,
            availability_topic: this.availabilityTopic,
            payload_available: 'online',
            payload_not_available: 'offline'
        }

        if (capability.type === 'snapshot') {
            message.topic = componentTopic+'/image'
        } else {
            message.state_topic = componentTopic+'/state'
        }

        if (capability.attributes) { message.json_attributes_topic = componentTopic+'/attributes' }
        if (capability.className) { message.device_class = capability.className }

        if (capability.command) {
            if (capability.type !== 'snapshot') {
                message.command_topic = componentTopic+'/'+capability.command
            }
            this.mqttClient.subscribe(componentTopic+'/'+capability.command)
        }

        // Set the primary state value for info sensors based on power (battery/wired)
        // and connectivity (Wifi/ethernet)
        if (capability.type === 'info') {
            message.json_attributes_topic = componentTopic+'/state'
            message.icon = 'mdi:information-outline'
            const deviceHealth = await Promise.race([this.camera.getHealth(), utils.sleep(5)]).then(function(result) { return result; })
            if (deviceHealth) {
                if (deviceHealth.network_connection && deviceHealth.network_connection === 'ethernet') {
                    message.value_template = '{{value_json["wiredNetwork"]}}'
                } else {
                    // Device is connected via wifi, track that as primary
                    message.value_template = '{{value_json["wirelessSignal"]}}'
                    message.unit_of_measurement = 'RSSI'
                }
            }
        }

        // Add device data for Home Assistant device registry
        message.device = this.deviceData

        debug('HASS config topic: '+configTopic)
        debug(message)
        this.mqttClient.publish(configTopic, JSON.stringify(message), { qos: 1 })
    }

    // Process a ding event from camera or publish existing ding state
    async processDing(ding) {
        // Is it an active ding (i.e. from a subscribed event)?
        if (ding) {
            // Is it a motion or doorbell ding? (for others we do nothing)
            if (ding.kind !== 'ding' && ding.kind !== 'motion') { return }

            debug('Ding of type '+ding.kind+' received at '+ding.now+' for camera '+this.deviceId)
            const stateTopic = this.cameraTopic+'/'+ding.kind+'/state'

            // Is this a new Ding or refresh of active ding?
            const newDing = (!this[ding.kind].active_ding) ? true : false
            this[ding.kind].active_ding = true

            // Update last_ding, duration and expire time
            this[ding.kind].last_ding = Math.floor(ding.now)
            this[ding.kind].ding_duration = ding.expires_in
            this[ding.kind].last_ding_expires = this[ding.kind].last_ding+ding.expires_in

            // If motion ding and snapshots on motion are enabled, publish a new snapshot
            if (ding.kind === 'motion' && this.snapshotMotion) {
                this.publishSnapshot(true)
                this[ding.kind].is_person = (ding.detection_type === 'human') ? true : false
            }

            // Publish MQTT active sensor state
            // Will republish to MQTT for new dings even if ding is already active
            this.publishDingState(ding.kind)

            // If new ding, begin expiration loop (only needed for first ding)
            if (newDing) {
                // Loop until current time is > last_ding expires time.  Sleeps until
                // estimated exire time, but may loop if new dings increase last_ding_expires
                while (Math.floor(Date.now()/1000) < this[ding.kind].last_ding_expires) {
                    const sleeptime = (this[ding.kind].last_ding_expires - Math.floor(Date.now()/1000)) + 1
                    debug('Ding of type '+ding.kind+' for camera '+this.deviceId+' expires in '+sleeptime)
                    await utils.sleep(sleeptime)
                    debug('Ding of type '+ding.kind+' for camera '+this.deviceId+' expired')
                }
                // All dings have expired, set ding state back to false/off and publish
                debug('All dings of type '+ding.kind+' for camera '+this.deviceId+' have expired')
                this[ding.kind].active_ding = false
                this.publishDingState(ding.kind)
            }
        } else {
            // Not an active ding so just publish existing ding state
            this.publishDingState('motion')
            if (this.camera.isDoorbot) {
                this.publishDingState('ding')
            }
        }
    }

    // Publish ding state and attributes
    publishDingState(dingKind) {
        const dingTopic = this.cameraTopic+'/'+dingKind
        const dingState = this[dingKind].active_ding ? 'ON' : 'OFF'
        const attributes = {}
        if (dingKind === 'motion') {
            attributes.lastMotion = this[dingKind].last_ding
            attributes.lastMotionTime = this[dingKind].last_ding_time
            attributes.personDetected = this[dingKind].is_person
        } else {
            attributes.lastDing = this[dingKind].last_ding
            attributes.lastDingTime = this[dingKind].last_ding_time
        }
        this.publishMqtt(dingTopic+'/state', dingState, true)
        this.publishMqtt(dingTopic+'/attributes', JSON.stringify(attributes), true)
    }

    // Publish camera state for polled attributes (light/siren state, etc)
    // Writes state to custom property to keep from publishing state except
    // when values change from previous polling interval
    publishPolledState() {
        if (this.camera.hasLight) {
            const stateTopic = this.cameraTopic+'/light/state'
            if (this.camera.data.led_status !== this.publishedLightState) {
                this.publishMqtt(stateTopic, (this.camera.data.led_status === 'on' ? 'ON' : 'OFF'), true)
                this.publishedLightState = this.camera.data.led_status
            }
        }
        if (this.camera.hasSiren) {
            const stateTopic = this.cameraTopic+'/siren/state'
            const sirenStatus = this.camera.data.siren_status.seconds_remaining > 0 ? 'ON' : 'OFF'
            if (sirenStatus !== this.publishedSirenState) {
                this.publishMqtt(stateTopic, sirenStatus, true)
                this.publishedSirenState = sirenStatus
            }
        }

        // Reset heartbeat counter on every polled state and set device online if not already
        this.heartbeat = 3
        if (this.availabilityState !== 'online') { this.online() }
    }

    // Publish device data to info topic
    async publishInfoState() {
        const deviceHealth = await this.camera.getHealth()
        
        if (deviceHealth) {
            const attributes = {}
            if (this.camera.hasBattery) {
                attributes.batteryLevel = deviceHealth.battery_percentage
            }
            attributes.firmwareStatus = deviceHealth.firmware
            attributes.lastUpdate = deviceHealth.updated_at
            if (deviceHealth.network_connection && deviceHealth.network_connection === 'ethernet') {
                attributes.wiredNetwork = this.camera.data.alerts.connection
            } else {
                attributes.wirelessNetwork = deviceHealth.wifi_name
                attributes.wirelessSignal = deviceHealth.latest_signal_strength
            }            
            this.publishMqtt(this.cameraTopic+'/info/state', JSON.stringify(attributes), true)
        }
    }

    // Publish snapshot image/metadata
    async publishSnapshot(refresh) {
        let newSnapshot
        // If refresh = true, get updated snapshot image before publishing
        if (refresh) {
            try {
                newSnapshot = await this.getRefreshedSnapshot()
            } catch(e) {
                debug(e.message)
            }
            if (newSnapshot) {
                this.snapshot.imageData = newSnapshot
                this.snapshot.timestamp = Math.round(Date.now()/1000)
            } else {
                debug('Could not retrieve updated snapshot for camera '+this.deviceId+', using previously cached snapshot')
            }
        }

        debug(this.cameraTopic+'/snapshot/image', '<binary_image_data>')
        this.publishMqtt(this.cameraTopic+'/snapshot/image', this.snapshot.imageData)
        this.publishMqtt(this.cameraTopic+'/snapshot/attributes', JSON.stringify({ timestamp: this.snapshot.timestamp }))
    }

    // This function uses various methods to get a snapshot to work around limitations
    // of Ring API, ring-client-api snapshot caching, battery cameras, etc.
    async getRefreshedSnapshot() {
        if (this.camera.snapshotsAreBlocked) {
            debug('Snapshots are unavailable for camera '+this.deviceId+', check if motion capture is disabled manually or via modes settings')
            return false
        }

        if (this.motion.active_ding) {
            if (this.camera.operatingOnBattery) {
                // Battery powered cameras can't take snapshots while recording, try to get image from video stream instead
                debug('Motion event detected on battery powered camera '+this.deviceId+', attempting to grab snapshot from live stream')
                return await this.getSnapshotFromStream()
            } else {
                // Line powered cameras can take a snapshot while recording, but ring-client-api will return a cached
                // snapshot if a previous snapshot was taken within 10 seconds. If a motion event occurs suring this time
                // a stale image is returned.  Instead, call our local function to force an uncached snapshot.
                debug('Motion event detected for line powered camera '+this.deviceId+', forcing a non-cached snapshot update')
                return await this.getUncachedSnapshot()
            }
        } else {
            return await this.camera.getSnapshot()
        }
    }

    // Bypass ring-client-api cached snapshot behavior by calling refresh snapshot API directly
    async getUncachedSnapshot() {
        await this.camera.requestSnapshotUpdate()
        await utils.sleep(1)
        const newSnapshot = await this.camera.restClient.request({
            url: clientApi(`snapshots/image/${this.camera.id}`),
            responseType: 'buffer',
        })
        return newSnapshot
    }

    // Refresh snapshot on scheduled interval
    async scheduleSnapshotRefresh() {
        await utils.sleep(this.snapshotInterval)
        // During active motion events or device offline state, stop interval snapshots
        if (this.snapshotMotion && !this.motion.active_ding && this.availabilityState === 'online') { 
            this.publishSnapshot(true)
        }
        this.scheduleSnapshotRefresh()
    }

    // Start a live stream to file with the defined duration
    async startStream(duration, filename) {
        debug('Establishing connection to video stream for camera '+this.deviceId)
        try {
            const sipSession = await this.camera.streamVideo({
                output: ['-codec', 'copy', '-flush_packets', '1', '-t', duration, filename, ],
            })

            sipSession.onCallEnded.subscribe(() => {
                try {
                    if (fs.existsSync(filename)) { fs.unlinkSync(filename) }
                } catch(err) {
                    debug(err.message)
                }
            }) 
            return sipSession
        } catch(e) {
            debug(e.message)
            return false
        }
    }

    // Check if stream to file has started within defined duration in seconds
    async isStreaming(filename, seconds) {
        for (let i = 0; i < seconds*10; i++) {
            if (utils.checkFile(filename, 100000)) { return true }
            await utils.msleep(100)
        }
        return false
    }

    // Attempt to start live stream with retries
    async tryInitStream(filePath, retries) {
        for (let i = 0; i < retries; i++) {
            const filePrefix = this.deviceId+'_motion_'+Date.now() 
            const aviFile = path.join(filePath, filePrefix+'.avi')
            const streamSession = await this.startStream(10, aviFile)
            if (streamSession) {
                if (await this.isStreaming(aviFile, 7)) {
                    debug ('Established live stream for camera '+this.deviceId)
                    return aviFile
                } else {
                    // SIP session established but never got a valid stream
                    debug ('Live stream established but no stream received for camera '+this.deviceId)
                }
            } else {
                debug ('Failed to establish live stream for camera '+this.deviceId)
                // SIP session failed hard, wait a few seconds before trying again
                await utils.sleep(3)
            }
            if (i < retries-1) { debug('Retrying live stream for camera '+this.deviceId) } 
        }
        debug ('Failed to establish live stream for camera '+this.deviceId+' after all retries, aborting!')
        return false
    }

    async getSnapshotFromStream() {
        if (this.snapshot.updating) {
            debug ('Snapshot update from live stream already in progress for camera '+this.deviceId)
            return
        }
        this.snapshot.updating = true
        let newSnapshot = false
        const aviFile = await this.tryInitStream('/tmp', 3)
        
        if (aviFile) {
            debug('Grabbing snapshot from live stream for camera '+this.deviceId)
            const filePrefix = this.deviceId+'_motion_'+Date.now() 
            const jpgFile = path.join('/tmp', filePrefix+'.jpg')
            try {
                // Attempt to grab snapshot image from key frame in stream
                await spawn(pathToFfmpeg, ['-i', aviFile, '-s', '640:360', '-vf', "select='eq(pict_type\,I)'", '-vframes', '1', '-q:v', '2', jpgFile])
                if (utils.checkFile(jpgFile)) {
                    newSnapshot = fs.readFileSync(jpgFile)
                    fs.unlinkSync(jpgFile)
                }
            } catch (e) {
                console.log(e.stderr.toString())
            }
        }

        if (newSnapshot) {
            debug('Successfully grabbed a snapshot from live stream for camera '+this.deviceId)
        } else {
            debug('Failed to get snapshot from live stream for camera '+this.deviceId)
        }
        this.snapshot.updating = false
        return newSnapshot
    }

    // Publish heath state every 5 minutes when online
    async publishDeviceHealth() {
        let delay = 60 // Default delay when offline
        if (this.availabilityState === 'online') {
            publishInfoState()
            delay = 300 // Every 5 minues when online
        }
        await utils.sleep(delay)
        this.publishDeviceHealth()
    }

    // Simple heartbeat function decrements the heartbeat counter every 20 seconds.
    // Normallt the 20 second polling events reset the heartbeat counter.  If counter
    // reaches 0 it indicates that polling has stopped so device is set offline.
    // When polling resumes and heartbeat counter is reset above zero, device is set online.
    async monitorCameraConnection() {
        if (this.heartbeat < 1 && this.availabilityState !== 'offline') {
            this.offline()
        } else {
            this.heartbeat--
        }
        await utils.sleep(20)
        this.monitorCameraConnection()
    }

    // Process messages from MQTT command topic
    processCommand(message, topic) {
        topic = topic.split('/')
        const component = topic[topic.length - 2]
        switch(component) {
            case 'light':
                this.setLightState(message)
                break;
            case 'siren':
                this.setSirenState(message)
                break;
            case 'snapshot':
                this.setSnapshotInterval(message)
                break;
            default:
                debug('Somehow received message to unknown state topic for camera '+this.deviceId)
        }
    }

    // Set switch target state on received MQTT command message
    setLightState(message) {
        debug('Received set light state '+message+' for camera '+this.deviceId)
        debug('Location Id: '+ this.locationId)
        switch (message) {
            case 'ON':
                this.camera.setLight(true)
                break;
            case 'OFF':
                this.camera.setLight(false)
                break;
            default:
                debug('Received unknown command for light on camera '+this.deviceId)
        }
    }

    // Set switch target state on received MQTT command message
    setSirenState(message) {
        debug('Received set siren state '+message+' for camera '+this.deviceId)
        debug('Location '+ this.locationId)
        switch (message) {
            case 'ON':
                this.camera.setSiren(true)
                break;
            case 'OFF':
                this.camera.setSiren(false)
                break;
            default:
                debug('Received unkonw command for light on camera '+this.deviceId)
        }
    }

    // Set refresh interval for snapshots
    setSnapshotInterval(message) {
        debug('Received set snapshot refresh interval '+message+' for camera '+this.deviceId)
        debug('Location Id: '+ this.locationId)
        if (isNaN(message)) {
            debug ('Received invalid interval')
        } else {
            this.snapshotInterval = (message >= 10) ? Math.round(message) : 10
            this.snapshotAutoInterval = false
            debug ('Snapshot refresh interval as been set to '+this.snapshotInterval+' seconds')
        }
    }

    // Publish availability state
    publishAvailabilityState(enableDebug) {
        this.publishMqtt(this.availabilityTopic, this.availabilityState, enableDebug)
    }

    // Set state topic online
    async online() {
        const enableDebug = (this.availabilityState == 'online') ? false : true
        await utils.sleep(1)
        this.availabilityState = 'online'
        this.publishAvailabilityState(enableDebug)
    }

    // Set state topic offline
    offline() {
        const enableDebug = (this.availabilityState == 'offline') ? false : true
        this.availabilityState = 'offline'
        this.publishAvailabilityState(enableDebug)
    }
}

module.exports = Camera
