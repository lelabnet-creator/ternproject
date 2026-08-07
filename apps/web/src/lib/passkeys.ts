import {
  browserSupportsWebAuthn,
  platformAuthenticatorIsAvailable,
  startAuthentication,
  startRegistration,
} from '@simplewebauthn/browser'
import { adminApi } from './adminApi'

/**
 * The browser half of passkeys.
 *
 * Two round trips each way, and the shape is the same both times: ask the
 * server for options, hand them to the browser, send back whatever the
 * authenticator signed. Everything security-relevant happens on the server —
 * see `apps/api/src/services/webauthn.ts`.
 *
 * This module exists mostly for the third concern: turning the browser's
 * exceptions into sentences a person can act on. `startRegistration` throws a
 * `DOMException` whose message is written for whoever is debugging the browser,
 * not for whoever is trying to sign in.
 */

export function passkeysSupported(): boolean {
  return browserSupportsWebAuthn()
}

/** Whether *this device* can hold one — a laptop's enclave, Touch ID, Windows Hello. */
export function devicePasskeyAvailable(): Promise<boolean> {
  return platformAuthenticatorIsAvailable()
}

/**
 * Thrown when the person changed their mind, which is not a failure.
 *
 * Dismissing the browser's prompt raises `NotAllowedError`, the same exception
 * as a genuine refusal by the authenticator. Showing a red banner for someone
 * who pressed Escape is worse than showing nothing, so callers are given a way
 * to tell the two apart.
 */
export class PasskeyCancelled extends Error {
  constructor() {
    super('Cancelled')
    this.name = 'PasskeyCancelled'
  }
}

function translate(error: unknown): Error {
  if (error instanceof Error) {
    if (error.name === 'NotAllowedError') return new PasskeyCancelled()

    // Raised when the authenticator is already registered on this account —
    // `excludeCredentials` doing its job. The browser's own wording is
    // "InvalidStateError", which tells the reader nothing.
    if (error.name === 'InvalidStateError') {
      return new Error('This device already has a passkey for this account.')
    }

    // The usual cause is an origin the credential was not created for: an
    // instance reached over plain http, or by IP, or on a hostname other than
    // the configured one. Worth naming, because it is a configuration problem
    // and not something pressing the button again will fix.
    if (error.name === 'SecurityError') {
      return new Error(
        'This address cannot use passkeys. They require https and the hostname the instance was set up with.',
      )
    }
  }

  return error instanceof Error ? error : new Error('That did not work')
}

/** Enrols a new passkey on the signed-in account. */
export async function enrolPasskey(name: string) {
  const options = await adminApi.passkeyRegisterOptions()

  let attestation
  try {
    attestation = await startRegistration({ optionsJSON: options as never })
  } catch (error) {
    throw translate(error)
  }

  return adminApi.registerPasskey(attestation, name)
}

/**
 * Signs in with a passkey, with nobody named first.
 *
 * No email is asked for: the options carry no credential list, so the browser
 * offers whatever it holds for this site and the assertion says which one was
 * used. That is not only nicer — asking for an address first would tell whoever
 * typed it whether that address has an account.
 */
export async function signInWithPasskey() {
  const options = await adminApi.passkeyLoginOptions()

  let assertion
  try {
    assertion = await startAuthentication({ optionsJSON: options as never })
  } catch (error) {
    throw translate(error)
  }

  return adminApi.passkeyLogin(assertion)
}
