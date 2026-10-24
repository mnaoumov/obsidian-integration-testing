/**
 * @file
 *
 * Remembers that the Appium toolchain — Appium itself and the driver the
 * harness needs — was verified installed, so a run does not re-probe it every
 * time it auto-starts a server.
 *
 * The probes are `npx --no-install appium --version` and
 * `npx --no-install appium driver list --installed --json`. They take 1.5-3s on
 * an idle host, and they took **about four minutes each** in four of the six
 * transport creations of one Android run on 2026-10-23, on a host the bulk
 * runner was keeping busy. Measured by hand the same evening under 88-100% CPU
 * they took 1.3-3.5s again, so it is not CPU load; it is most likely npm
 * contending with the other sessions' npm work. Eight minutes of probing ate
 * most of a suite's 540s registration budget before a single emulator was
 * launched, and every suite in this repo provisions its own transport.
 *
 * So a verified toolchain is recorded here, next to the other harness markers,
 * and trusted for {@link APPIUM_TOOLCHAIN_MARKER_MAX_AGE_IN_MILLISECONDS}. A
 * toolchain removed inside that window is not missed silently: the server spawn
 * then fails at once with npx's own message (**L27**), and the harness clears
 * the marker when an auto-started server dies during startup, so the next run
 * probes again.
 *
 * Tolerant like the other markers: a missing, unreadable or malformed marker
 * reads as "not verified", which costs only the probes.
 */

import {
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { log } from './log.ts';

/**
 * How long a verified toolchain is trusted: long enough to cover a day's runs on
 * a busy machine, short enough that an upgrade or removal is re-probed the same
 * day.
 */
export const APPIUM_TOOLCHAIN_MARKER_MAX_AGE_IN_MILLISECONDS = 21_600_000;

/*
 * A probe this slow is reported as host contention: an idle host answers in
 * 1.5-3s, and one that merely runs an emulator in under 4s.
 */
const SLOW_PROBE_THRESHOLD_IN_MILLISECONDS = 30_000;

const MILLISECONDS_IN_SECOND = 1000;
const MARKER_DIR_NAME = 'obsidian-integration-testing';
const MARKER_FILE_NAME = 'appium-toolchain.json';

/**
 * A verified Appium toolchain.
 */
export interface AppiumToolchainMarker {
  /**
   * The Appium version `appium --version` reported.
   */
  readonly appiumVersion: string;

  /**
   * When the toolchain was verified (`Date.now()` epoch milliseconds).
   */
  readonly checkedAtInMilliseconds: number;

  /**
   * The driver that was verified installed.
   */
  readonly driverName: string;
}

/**
 * Parameters for {@link checkIsAppiumToolchainMarkerFresh}.
 */
export interface CheckIsAppiumToolchainMarkerFreshParams {
  /**
   * The driver this run needs.
   */
  readonly driverName: string;

  /**
   * The marker read, or `undefined` when there is none.
   */
  readonly marker: AppiumToolchainMarker | undefined;

  /**
   * The current time (`Date.now()` epoch milliseconds).
   */
  readonly nowInMilliseconds: number;
}

/**
 * {@link CheckIsAppiumToolchainMarkerFreshParams} once the check has found the marker fresh.
 */
export interface FreshAppiumToolchainMarkerParams extends CheckIsAppiumToolchainMarkerFreshParams {
  /**
   * The fresh marker.
   */
  readonly marker: AppiumToolchainMarker;
}

/**
 * Parameters for {@link writeAppiumToolchainMarker}.
 */
export interface WriteAppiumToolchainMarkerParams {
  /**
   * The Appium version `appium --version` reported.
   */
  readonly appiumVersion: string;

  /**
   * The driver that was verified installed.
   */
  readonly driverName: string;
}

/**
 * Checks whether a marker still vouches for the toolchain this run needs.
 *
 * A marker from the future is not fresh: a clock set back would otherwise keep
 * a marker trusted for as long as the clock is off.
 *
 * @param params - The marker, the driver needed and the current time.
 * @returns `true` when the probes can be skipped.
 */
export function checkIsAppiumToolchainMarkerFresh(params: CheckIsAppiumToolchainMarkerFreshParams): params is FreshAppiumToolchainMarkerParams {
  const { driverName, marker, nowInMilliseconds } = params;
  if (marker?.driverName !== driverName) {
    return false;
  }

  const ageInMilliseconds = nowInMilliseconds - marker.checkedAtInMilliseconds;
  return ageInMilliseconds >= 0 && ageInMilliseconds < APPIUM_TOOLCHAIN_MARKER_MAX_AGE_IN_MILLISECONDS;
}

/**
 * Removes the marker, so the next run probes the toolchain again.
 */
export function clearAppiumToolchainMarker(): void {
  try {
    rmSync(getMarkerFilePath(), { force: true });
  } catch (error: unknown) {
    log(`[appium-toolchain-marker] Could not remove the marker: ${getErrorMessage(error)}`);
  }
}

/**
 * Describes how long a toolchain probe took, naming host contention when it was slow.
 *
 * @param durationInMilliseconds - How long the probe took.
 * @returns The description, for the line that reports the probe's answer.
 */
export function describeProbeDuration(durationInMilliseconds: number): string {
  const seconds = (durationInMilliseconds / MILLISECONDS_IN_SECOND).toFixed(1);
  return durationInMilliseconds < SLOW_PROBE_THRESHOLD_IN_MILLISECONDS
    ? `the probe took ${seconds}s`
    : `the probe took ${seconds}s against 1.5-3s on an idle host, so npx was starved by the host's load; the toolchain itself is fine`;
}

/**
 * Reads the marker.
 *
 * @returns The marker, or `undefined` when there is none or it is unreadable or malformed.
 */
export function readAppiumToolchainMarker(): AppiumToolchainMarker | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(getMarkerFilePath(), 'utf-8'));
  } catch {
    return undefined;
  }

  if (typeof parsed !== 'object' || parsed === null) {
    return undefined;
  }

  const { appiumVersion, checkedAtInMilliseconds, driverName } = parsed as Record<string, unknown>;
  return typeof appiumVersion !== 'string' || typeof checkedAtInMilliseconds !== 'number' || typeof driverName !== 'string'
    ? undefined
    : { appiumVersion, checkedAtInMilliseconds, driverName };
}

/**
 * Records a toolchain this run just verified, stamped with the current time.
 *
 * @param params - The Appium version and the driver verified.
 */
export function writeAppiumToolchainMarker(params: WriteAppiumToolchainMarkerParams): void {
  const marker: AppiumToolchainMarker = {
    appiumVersion: params.appiumVersion,
    checkedAtInMilliseconds: Date.now(),
    driverName: params.driverName
  };

  try {
    mkdirSync(getMarkerDirectory(), { recursive: true });
    writeFileSync(getMarkerFilePath(), JSON.stringify(marker));
  } catch (error: unknown) {
    log(`[appium-toolchain-marker] Could not record the verified toolchain: ${getErrorMessage(error)}`);
  }
}

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function getMarkerDirectory(): string {
  return join(tmpdir(), MARKER_DIR_NAME);
}

function getMarkerFilePath(): string {
  return join(getMarkerDirectory(), MARKER_FILE_NAME);
}
