import {afterEach, describe, expect, test} from 'bun:test'
import {isBlockedHost} from './text.ts'

afterEach(() => {
 delete process.env.TIA_NATIVE_SEARCH_ALLOW_PRIVATE
})

describe('isBlockedHost', () => {
 test('blocks loopback, link-local, metadata, RFC1918, unique-local, and 0.0.0.0', () => {
  delete process.env.TIA_NATIVE_SEARCH_ALLOW_PRIVATE
  for (const host of ['127.0.0.1', '127.5.6.7', '169.254.169.254', '169.254.0.1', '10.0.0.1', '172.16.0.1', '172.31.255.255', '192.168.1.1', '0.0.0.0', '::1', 'localhost', 'foo.localhost', 'fe80::1', 'fc00::1', 'fd12:3456::1', '::ffff:127.0.0.1']) {
   expect(isBlockedHost(host)).toBe(true)
  }
 })

 test('allows public hosts', () => {
  delete process.env.TIA_NATIVE_SEARCH_ALLOW_PRIVATE
  for (const host of ['example.com', 'docs.example.org', '8.8.8.8', '1.1.1.1', '172.32.0.1', '172.15.0.1', '93.184.216.34', '2606:2800:220:1::248', 'google.com']) {
   expect(isBlockedHost(host)).toBe(false)
  }
 })

 test('blocks private targets via the production URL hostname path (incl IPv4-mapped IPv6)', () => {
  delete process.env.TIA_NATIVE_SEARCH_ALLOW_PRIVATE
  for (const url of ['http://[::ffff:127.0.0.1]/', 'http://[::ffff:169.254.169.254]/', 'http://[::ffff:10.0.0.1]/', 'http://[::ffff:192.168.1.1]/', 'http://[::ffff:172.16.0.1]/', 'http://127.0.0.1/', 'http://169.254.169.254/', 'http://[::1]/', 'http://localhost/']) {
   expect(isBlockedHost(new URL(url).hostname)).toBe(true)
  }
 })

 test('allows public targets via the production URL hostname path (incl IPv4-mapped public IPs)', () => {
  delete process.env.TIA_NATIVE_SEARCH_ALLOW_PRIVATE
  for (const url of ['http://example.com/', 'http://8.8.8.8/', 'http://[::ffff:8.8.8.8]/', 'http://[2606:4700:4700::1111]/', 'http://172.32.0.1/']) {
   expect(isBlockedHost(new URL(url).hostname)).toBe(false)
  }
 })

 test('TIA_NATIVE_SEARCH_ALLOW_PRIVATE=1 opts out of all blocking', () => {
  process.env.TIA_NATIVE_SEARCH_ALLOW_PRIVATE = '1'
  for (const host of ['127.0.0.1', '169.254.169.254', '10.0.0.1', '192.168.0.1', '::1', 'localhost']) {
   expect(isBlockedHost(host)).toBe(false)
  }
 })
})
