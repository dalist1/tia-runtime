import {expect, test} from 'bun:test'
import {validateRpcOutput} from './runtime-boundaries.ts'

const state = {type: 'response', id: 'state', command: 'get_state', success: true, data: {isStreaming: false, messageCount: 0, model: {provider: 'openai'}}}
const commands = {type: 'response', id: 'commands', command: 'get_commands', success: true, data: {commands: [{name: 'boundary_probe'}]}}
const lines = (...events: unknown[]) => events.map(event => JSON.stringify(event)).join('\n')

test('runtime benchmark requires successful RPC state and registered extension commands', () => {
 expect(() => validateRpcOutput(lines(state), false)).not.toThrow()
 expect(() => validateRpcOutput(lines(state, commands), true)).not.toThrow()
 for (const output of ['', 'not json', lines({...state, success: false}), lines({...state, data: {...state.data, isStreaming: true}}), lines({...state, data: {...state.data, messageCount: 1}})]) {
  expect(() => validateRpcOutput(output, false)).toThrow()
 }
 for (const output of [lines(state), lines(state, {...commands, success: false}), lines(state, {...commands, data: {commands: []}}), lines({...state, data: {...state.data, model: {provider: 'wrong'}}}, commands)]) {
  expect(() => validateRpcOutput(output, true)).toThrow()
 }
})
