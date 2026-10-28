'use strict';
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const { dirname, resolve } = require('node:path');
const { Duplex } = require('node:stream');

const LABEL = 'factuez.b2b.received-dispatch.redis-test';
const CAPABILITY = 'FACTUEZ_B2B_RECEIVED_DISPATCH_OWNED_REDIS';
const dockerExecutable = process.platform === 'win32'
  ? 'C:\\Program Files\\Docker\\Docker\\resources\\bin\\docker.exe' : '/usr/bin/docker';
const dockerHost = process.platform === 'win32'
  ? 'npipe:////./pipe/docker_engine' : 'unix:///var/run/docker.sock';
const dockerArgs = args => ['--host', dockerHost, ...args];

// Deliberately do not copy process.env, user Docker contexts, app config or secrets.
// Only OS launch essentials and the runner's new synthetic capability are supplied.
function isolatedEnvironment(capability) {
  const env = process.platform === 'win32' ? {
    SystemRoot: 'C:\\Windows', WINDIR: 'C:\\Windows', SystemDrive: 'C:',
    ComSpec: 'C:\\Windows\\System32\\cmd.exe',
    PATH: [dirname(process.execPath), 'C:\\Windows\\System32', 'C:\\Windows'].join(';'),
    TEMP: 'C:\\Windows\\Temp', TMP: 'C:\\Windows\\Temp',
  } : { PATH: '/usr/local/bin:/usr/bin:/bin', LANG: 'C.UTF-8', TMPDIR: '/tmp' };
  Object.assign(env, { CI: '1', NO_COLOR: '1' });
  if (capability) env[CAPABILITY] = JSON.stringify(capability);
  return env;
}
function validateCapability(value) {
  assert.equal(value?.version, 1, 'EXPLICIT_OWNED_REDIS_RUNNER_REQUIRED');
  assert.match(value.runId, /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/);
  assert.match(value.container, /^[a-f0-9]{64}$/);
  for (const key of ['password', 'upstreamSecret']) assert.match(value[key], /^synthetic-[a-f0-9]{48}$/);
  return value;
}
function testCapability() {
  // This is a test-only value created by our runner, never an application variable.
  const text = process.env[CAPABILITY];
  assert.ok(text, 'EXPLICIT_OWNED_REDIS_RUNNER_REQUIRED');
  return validateCapability(JSON.parse(text));
}
function createDockerConnector(capability) {
  validateCapability(capability);
  const streams = new Set();
  const children = new Set();
  let stopped = false;
  class ChildDuplex extends Duplex {
    constructor() {
      super({ allowHalfOpen: false });
      this.connecting = true;
      this.remoteAddress = '127.0.0.1';
      this.remotePort = 6379;
      streams.add(this);
      this.once('close', () => streams.delete(this));
      this.on('error', () => {}); // ioredis receives its own sanitized error event.
      this.child = spawn(dockerExecutable, dockerArgs([
        'exec', '-i', capability.container, 'nc', '127.0.0.1', '6379',
      ]), { windowsHide: true, env: isolatedEnvironment(), stdio: ['pipe', 'pipe', 'ignore'] });
      children.add(this.child);
      this.child.once('close', () => {
        children.delete(this.child);
        if (!this.destroyed) this.destroy();
      });
      this.child.once('error', () => this.destroy(new Error('OWNED_REDIS_STREAM_FAILED')));
      this.child.stdin.on('error', () => this.destroy(new Error('OWNED_REDIS_STREAM_FAILED')));
      this.child.stdout.on('error', () => this.destroy(new Error('OWNED_REDIS_STREAM_FAILED')));
      this.child.stdout.on('data', chunk => { if (!this.push(chunk)) this.child.stdout.pause(); });
      this.child.stdout.once('end', () => this.push(null));
      this.child.once('spawn', () => {
        if (this.destroyed) return;
        this.connecting = false;
        this.emit('connect');
      });
    }
    setNoDelay() { return this; }
    setKeepAlive() { return this; }
    ref() { this.child?.ref(); return this; }
    unref() { this.child?.unref(); return this; }
    setTimeout(ms, callback) {
      clearTimeout(this.timeout);
      this.timeout = undefined;
      if (ms > 0) this.timeout = setTimeout(() => { this.timeout = undefined; callback?.(); }, ms);
      return this;
    }
    _read() { this.child?.stdout.resume(); }
    _write(chunk, encoding, callback) {
      // Unlike a TCP socket, BusyBox nc can keep its stdin/stdio tunnel open
      // after Redis closes the peer. Half-close only after the actual RESP
      // QUIT command has flushed; the readable side still receives its reply.
      const quit=/^\*1\r\n\$4\r\nquit\r\n$/i.test(chunk.toString('utf8'));
      this.child.stdin.write(chunk, encoding, error=>{
        callback(error);
        if(quit&&!error&&!this.writableEnded)this.end();
      });
    }
    _final(callback) { this.child.stdin.end(callback); }
    _destroy(error, callback) {
      clearTimeout(this.timeout);
      this.timeout = undefined;
      this.child?.stdin.destroy();
      this.child?.stdout.destroy();
      if (this.child && this.child.exitCode === null) this.child.kill();
      callback(error);
    }
  }
  // ioredis 5.x: new Connector(options), connect(errorEmitter): Promise<NetStream>.
  // Its Promise callback installs socket listeners before the child's spawn/connect.
  class Connector {
    constructor(options) {
      assert.equal(options.host, '127.0.0.1');
      assert.equal(options.port, 6379);
      assert.equal(options.password, capability.password);
      this.connecting = false;
    }
    async connect(_callback) {
      assert.equal(stopped, false, 'OWNED_REDIS_CONNECTOR_CLOSED');
      this.connecting = true;
      this.stream = new ChildDuplex();
      this.stream.once('error', error => { this.firstError = error; });
      return this.stream;
    }
    check() { return true; }
    disconnect() { this.connecting = false; this.stream?.destroy(); }
  }
  async function drain() {
    const deadline = Date.now() + 3000;
    while (streams.size || children.size) {
      assert.ok(Date.now() < deadline, 'OWNED_REDIS_STREAMS_NOT_DRAINED');
      await new Promise(resolve => setTimeout(resolve, 20));
    }
  }
  return {
    Connector,
    drain,
    async shutdown() {
      stopped = true;
      for (const stream of streams) stream.destroy();
      await drain();
    },
  };
}
module.exports = { LABEL, CAPABILITY, dockerExecutable, dockerArgs, isolatedEnvironment, testCapability, createDockerConnector };
