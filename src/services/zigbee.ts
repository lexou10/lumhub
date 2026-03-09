const zigbee = require('../../dist/services/zigbee')

export const sendCommand        = zigbee.sendCommand        as (ieeeAddress: string, key: string, value: any) => Promise<void>
export const startPairing       = zigbee.startPairing       as (duration: number) => void
export const stopPairing        = zigbee.stopPairing        as () => void
export const startZigbeeService = zigbee.startZigbeeService as () => Promise<void>
export const stopZigbeeService  = zigbee.stopZigbeeService  as () => void
