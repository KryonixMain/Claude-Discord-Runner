// Shared mutable process references — imported by process.js and all handlers that need isRunning()
import { EventEmitter } from "events";

const emitter = new EventEmitter();

let runningProcess     = null;
let securityFixProcess = null;
let paused             = false;
let scheduledTimer     = null;

export function getRunningProcess()      { return runningProcess; }
export function setRunningProcess(p)     { runningProcess = p; }
export function getSecurityFixProcess()  { return securityFixProcess; }
export function setSecurityFixProcess(p) { securityFixProcess = p; }

export function isRunning() {
  return runningProcess !== null && !runningProcess.killed;
}
export function isSecurityFixRunning() {
  return securityFixProcess !== null && !securityFixProcess.killed;
}

export function isPaused()     { return paused; }
export function setPaused(val) {
  paused = !!val;
  if (!paused) emitter.emit("unpause");
}

export function waitForUnpause() {
  return new Promise((resolve) => {
    if (!paused) return resolve();
    emitter.once("unpause", resolve);
  });
}

export function getScheduledTimer()     { return scheduledTimer; }
export function setScheduledTimer(t)    { scheduledTimer = t; }
export function clearScheduledTimer() {
  if (scheduledTimer) clearTimeout(scheduledTimer);
  scheduledTimer = null;
}
