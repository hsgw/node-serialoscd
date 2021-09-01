#!/usr/bin/env node

const SerialPort = require("serialport");
const freeUdpPort = require("udp-free-port");
const fs = require("fs");
const program = require("commander");
const { UdpReceiver, UdpSender } = require("omgosc");

// helpers

const isGoodPort = (port) => {
  if (typeof port === "string") {
    port = parseInt(port);

    if (isNaN(port)) {
      return false;
    }
  }

  return port > 0 && port < 65536;
};

const packNybbles = (data) => {
  const out = [];

  for (let i = 0; i < data.length; i += 2) {
    out.push((data[i] << 4) | (data[i + 1] & 0x0f));
  }

  return out;
};

// init

program
  .version(require("./package.json").version)
  .usage("node-serialoscd MONOME_TTY")
  .option("-d, --debug", "show debugging information")
  .option("-b, --baud <baudrate>", "specify baud rate (defaults to 115200)")
  .option("-o, --osc <port>", "specify OSC port (defaults to 12002)")
  .option("-ao, --apposc <port>", "specify application OSC port (no default)")
  .option(
    "-s, --size <16x8>",
    "specify Monome size (requests from device by default)"
  )
  .parse(process.argv);

if (!program.args.length) {
  program.help();
  process.exit(0);
}

// logging

const log = program.debug ? console.log : () => {};
const stringify = (json) => JSON.stringify(json, null, 2);

// osc connections

const connections = {};

// consts

const BAUD_RATE = program.baud ? parseInt(program.baud) : 115200;
const MASTER_RECEIVER_PORT = program.osc ? parseInt(program.osc) : 12002;
const DEVICE = "m0000000";
const DEFAULT_PREFIX = `/${DEVICE}`;

let sysId = "monome";
let size = program.size
  ? program.size.split("x").map((n) => parseInt(n))
  : undefined;

const OSC_TO_HARDWARE = {
  "/grid/led/set": (params) => [
    params[2] === 0 ? 0x10 : 0x11,
    params[0],
    params[1],
  ],
  "/grid/led/all": (params) => [params[0] === 0 ? 0x12 : 0x13],
  "/grid/led/map": (params) => [0x14, ...params],
  "/grid/led/row": (params) => [0x15, ...params],
  "/grid/led/col": (params) => [0x16, ...params],
  "/grid/led/intensity": (params) => [0x17, ...params],
  "/grid/led/level/set": (params) => [0x18, ...params],
  "/grid/led/level/all": (params) => [0x19, ...params],
  "/grid/led/level/map": (params) => [
    0x1a,
    params[0],
    params[1],
    ...packNybbles(params.slice(2)),
    // ...params,
  ],
  "/grid/led/level/row": (params) => [
    0x1b,
    // params[0],
    // params[1],
    // ...packNybbles(params.slice(2)),
    ...params,
  ],
  "/grid/led/level/col": (params) => [
    0x1c,
    // params[0],
    // params[1],
    // ...packNybbles(params.slice(2)),
    ...params,
  ],
};

const createKeyMessageHandler = (type) => (msg) => {
  if (msg.length < 6) {
    return;
  }

  const x = parseInt(msg.substring(2, 4), 16);
  const y = parseInt(msg.substring(4, 6), 16);

  log(">>> key");
  log(`${x}:${y} (${type})`);
  log();

  // notify all conections
  Object.keys(connections).forEach((key) => {
    const { deviceSender, prefix } = connections[key];
    deviceSender.send(`${prefix}/grid/key`, "iii", [x, y, type]);
  });
};

const HARDWARE_MESSAGE_HANDLERS = {
  "0x01": (_, raw) => {
    sysId = raw.slice(1).toString("ascii");

    log(">>> sys id");
    log(sysId);
    log();
  },
  "0x03": (msg) => {
    if (!size) {
      const x = parseInt(msg.substring(2, 4), 16);
      const y = parseInt(msg.substring(4, 6), 16);

      size = [x, y];
    }

    log(">>> size");
    log(`${size[0]}x${size[1]}`);
    log();
  },
  "0x20": createKeyMessageHandler(0),
  "0x21": createKeyMessageHandler(1),
};

const INIT_MESSAGES = [
  [0x01], // sysId
  [0x05], // size
];

// serial

const ttyFile = program.args[0];

// if (!fs.existsSync(ttyFile)) {
//   console.log(`${ttyFile} doesn't exist`);
//   process.exit(1);
// }

console.log(`opening ${ttyFile}...`);
const port = new SerialPort(ttyFile, { baudRate: BAUD_RATE });

// osc

const masterReceiver = new UdpReceiver(MASTER_RECEIVER_PORT);

const createConnection = (
  oscHost = "127.0.0.1",
  oscPort = 0,
  sysOscPort = 0
) => {
  const oscAddress = `${oscHost}:${oscPort}`;

  log(">>> starting connection");
  log(`oscAddress: ${oscAddress}`);
  log(`port: ${sysOscPort}`);
  log();

  // re-use existing values
  const deviceOscHost = connections[oscAddress]
    ? connections[oscAddress].deviceOscHost
    : oscHost;

  const deviceOscPort = connections[oscAddress]
    ? connections[oscAddress].deviceOscPort
    : oscPort;

  // create communication channels
  const receiver = new UdpReceiver(sysOscPort);
  const sysSender = new UdpSender(oscHost, oscPort);
  const deviceSender = new UdpSender(deviceOscHost, deviceOscPort);

  // store the connection
  connections[oscAddress] = {
    prefix: DEFAULT_PREFIX,
    sysSender,
    deviceSender,
    receiver,
    sysOscPort,
    deviceOscHost,
    deviceOscPort,
  };
  const connection = connections[oscAddress];

  // notify listener about our device
  // TODO: use sysId here?

  sysSender.send("/serialosc/device", "ssi", [DEVICE, DEVICE, sysOscPort]);

  // listen to sys messages
  receiver.on("", (e) => {
    log(">>> receiver");
    log(stringify(e));
    log();

    // update port if needed
    if (e.path === "/sys/port") {
      if (!isGoodPort(e.params[0])) {
        return;
      }

      const newDeviceOscPort = e.params[0];
      const newDeviceSender = new UdpSender(
        connection.oscHost,
        newDeviceOscPort
      );

      connection.deviceSender.close();
      connection.deviceSender = newDeviceSender;
      connection.deviceOscPort = newDeviceOscPort;

      newDeviceSender.send("/sys/port", "i", [newDeviceOscPort]);

      return;
    }

    // update host if needed
    if (e.path === "/sys/host") {
      const newDeviceOscHost = e.params[0];
      const newDeviceSender = new UdpSender(
        newDeviceOscHost,
        connection.deviceOscPort
      );

      connection.deviceSender.close();
      connection.deviceSender = newDeviceSender;
      connection.deviceOscHost = newDeviceOscHost;

      newDeviceSender.send("/sys/host", "i", [newDeviceOscHost]);

      return;
    }

    if (e.path === "/sys/prefix") {
      connection.prefix = e.params[0];

      return;
    }

    // dump all the values we have
    if (e.path === "/sys/info") {
      const sysMessages = [
        ["/sys/id", "s", [DEVICE]],
        ["/sys/size", "ii", size || [8, 8]],
        ["/sys/host", "s", [connection.deviceOscHost]],
        ["/sys/port", "i", [connection.deviceOscPort]],
        ["/sys/prefix", "s", [connection.prefix]],
        ["/sys/rotation", "i", [0]],
      ];

      sysMessages.forEach(([path, typetag, params]) => {
        connection.deviceSender.send(path, typetag, params);
      });

      return;
    }

    // otherwise handle hardware communications

    const pathWithoutPrefix = e.path.replace(connection.prefix, "");

    if (OSC_TO_HARDWARE[pathWithoutPrefix]) {
      const buffer = Buffer.from(OSC_TO_HARDWARE[pathWithoutPrefix](e.params));
      log(buffer);
      log(buffer.length);

      port.write(buffer, (e) => {
        if (e) {
          console.error(e);
        }
      });

      return;
    } else {
      console.error("unhandled message", e.path, e.params);
    }
  });
};

if (program.apposc) {
  const oscPort = parseInt(program.apposc);
  log("oscport %d", oscPort)
  createConnection("127.0.0.1", oscPort, oscPort);
}

port.on("open", (err) => {
  if (err) throw err;

  log("ready!");

  INIT_MESSAGES.forEach((msg) =>
    port.write(Buffer.from(msg), (e) => {
      if (e) {
        console.error(e);
      }
    })
  );

  masterReceiver.on("", (e) => {
    log(">>> master");
    log(stringify(e));
    log();

    // start communicating on /serialosc/list
    if (e.path === "/serialosc/list") {
      const oscHost = e.params[0];
      const oscPort = e.params[1];

      if (!isGoodPort(oscPort)) {
        return;
      }

      freeUdpPort((e, sysOscPort) => {
        if (e) {
          console.error(e);
        }

        createConnection(oscHost, oscPort, sysOscPort);
      });
    }
  });
});

// handle events from monome

port.on("data", (data) => {
  const hex = data.toString("hex");

  const msgType = `0x${hex.substring(0, 2)}`;

  if (HARDWARE_MESSAGE_HANDLERS[msgType]) {
    HARDWARE_MESSAGE_HANDLERS[msgType](hex, data);
  }
});
