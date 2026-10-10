/**
 * Types and constants shared between the web and api packages.
 * Wiring into the apps happens in 阶段一, when the first shared contract exists.
 */

export const APP_NAME = '梵禾 Work'
export const API_PORT = 8787

export type HealthResponse = {
  status: string
  service: string
  time: string
}
