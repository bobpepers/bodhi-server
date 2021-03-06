const { isEmpty, isUndefined, each, split } = require('lodash');
const { spawn, spawnSync } = require('child_process');
const portscanner = require('portscanner');

const { BIN_TYPE } = require('./constants');
const { Config, setQtumEnv, getEnvConfig, isMainnet, getRPCPassword } = require('./config');
const { initDB } = require('./db');
const { initLogger, getLogger } = require('./utils/logger');
const EmitterHelper = require('./utils/emitter-helper');
const { startSync } = require('./sync');
const { getInstance } = require('./qclient');
const { initApiServer } = require('./route');
const Wallet = require('./api/wallet');

const walletEncryptedMessage = 'Your wallet is encrypted. Please use a non-encrypted wallet for the server.';

let qtumProcess;
let encryptOk = false;
let isEncrypted = false;
let checkInterval;
let shutdownInterval;

function getQtumProcess() {
  return qtumProcess;
}

/**
 * Sets the env and inits all the required processes.
 * @param {string} env BLOCKCHAIN_ENV var for mainnet, testnet, or regtest.
 * @param {string} qtumPath Full path to the Qtum bin folder.
 * @param {boolean} encryptionAllowed Are encrypted Qtum wallets allowed.
 */
async function startServer(env, qtumPath, encryptionAllowed) {
  try {
    encryptOk = encryptionAllowed;
    setQtumEnv(env, qtumPath);
    initLogger();
    await initDB();
    startQtumProcess(false);
  } catch (err) {
    EmitterHelper.onServerStartError(err.message);
  }
}

/**
 * Starts the qtum daemon.
 * Will restart automatically if the chainstate is corrupted.
 * @param {boolean} reindex Should add the reindex flag when starting qtumd.
 */
function startQtumProcess(reindex) {
  try {
    const flags = [
      '-logevents',
      '-rpcworkqueue=32',
      `-rpcuser=${Config.RPC_USER}`,
      `-rpcpassword=${getRPCPassword()}`,
    ];
    if (!isMainnet()) {
      flags.push(`-${getEnvConfig().network}`);
    }
    if (reindex) {
      flags.push('-reindex');
    }
    if (!isEmpty(process.env.QTUM_DATA_DIR)) {
      flags.push(`-datadir=${process.env.QTUM_DATA_DIR}`);
    }

    const qtumdPath = `${getEnvConfig().qtumPath}/${BIN_TYPE.QTUMD}`;
    getLogger().info(`qtumd dir: ${qtumdPath}`);

    qtumProcess = spawn(qtumdPath, flags);
    getLogger().info(`qtumd started on PID ${qtumProcess.pid}`);

    qtumProcess.stdout.on('data', (data) => {
      getLogger().debug(`qtumd output: ${data}`);
    });

    qtumProcess.stderr.on('data', (data) => {
      getLogger().error(`qtumd failed with error: ${data}`);

      if (data.includes('You need to rebuild the database using -reindex-chainstate')) {
        // Clean old process first
        killQtumProcess(false);
        clearInterval(checkInterval);

        // Restart qtumd with reindex flag
        setTimeout(() => {
          getLogger().info('Restarting and reindexing Qtum blockchain');
          startQtumProcess(true);
        }, 3000);
      } else {
        // Emit startup error event to Electron listener
        EmitterHelper.onQtumError(data.toString('utf-8'));

        // add delay to give some time to write to log file
        setTimeout(() => process.exit(), 500);
      }
    });

    qtumProcess.on('close', (code) => {
      getLogger().debug(`qtumd exited with code ${code}`);
    });

    // repeatedly check if qtumd is running
    checkInterval = setInterval(checkQtumdInit, 500);
  } catch (err) {
    throw Error(`startQtumProcess: ${err.message}`);
  }
}

/**
 * Ensure qtumd is running before starting sync/API.
 */
async function checkQtumdInit() {
  try {
    // getInfo throws an error if trying to be called before qtumd is running
    await getInstance().getBlockchainInfo();

    // no error was caught, qtumd is initialized
    clearInterval(checkInterval);
    checkWalletEncryption();
  } catch (err) {
    if (err.message === walletEncryptedMessage) {
      throw Error(err.message);
    } else {
      getLogger().debug(err.message);
    }
  }
}

/**
 * Checks if the wallet is encrypted to prompt the wallet unlock dialog.
 * Electron version only. Don't run remote version with encrypted wallet.
 */
async function checkWalletEncryption() {
  const res = await Wallet.getWalletInfo();
  isEncrypted = !isUndefined(res.unlocked_until);

  if (isEncrypted) {
    // For Electron, flag passed via Electron Builder
    if (encryptOk) {
      EmitterHelper.onWalletEncrypted();
      return;
    }

    let flagFound = false;
    each(process.argv, (arg) => {
      if (arg === '--encryptok') {
        // For Electron, flag passed via command-line
        EmitterHelper.onWalletEncrypted();
        flagFound = true;
      } else if (arg.startsWith('--passphrase=')) {
        // For dev purposes, unlock wallet directly in server
        const passphrase = (split(arg, '=', 2))[1];
        unlockWallet(passphrase);
        flagFound = true;
      }
    });
    if (flagFound) {
      return;
    }

    // No flags found to handle encryption, crash server
    EmitterHelper.onServerStartError(walletEncryptedMessage);
    throw Error(walletEncryptedMessage);
  } else {
    startServices();
  }
}

/**
 * Used to unlock the wallet without having to use the Electron dialog.
 * The --passphrase flag with the passphrase must be passed via commandline.
 * @param {string} passphrase Passphrase to unlock wallet.
 */
async function unlockWallet(passphrase) {
  // Unlock wallet
  await Wallet.walletPassphrase({ passphrase, timeout: Config.UNLOCK_SECONDS });

  // Ensure wallet is unlocked
  const info = await Wallet.getWalletInfo();
  if (info.unlocked_until > 0) {
    getLogger().info('Wallet unlocked');
    startServices();
  } else {
    const errMessage = 'Wallet unlock failed';
    getLogger().error(errMessage);
    throw Error(errMessage);
  }
}

/**
 * Starts the services following a successful qtumd launch.
 */
function startServices() {
  startSync(true);
  initApiServer();
}

/**
 * Shuts down the already running qtumd and starts qtum-qt.
 * Electron version only.
 */
function startQtumWallet() {
  // Start qtum-qt
  const qtumqtPath = `${getEnvConfig().qtumPath}/${BIN_TYPE.QTUM_QT}`;
  getLogger().debug(`qtum-qt dir: ${qtumqtPath}`);

  // Construct flags
  const flags = ['-logevents'];
  if (!isMainnet()) {
    flags.push('-testnet');
  }

  const qtProcess = spawn(qtumqtPath, flags, {
    detached: true,
    stdio: 'ignore',
  });
  qtProcess.unref();
  getLogger().debug(`qtum-qt started on PID ${qtProcess.pid}`);

  // Kill backend process after qtum-qt has started
  setTimeout(() => process.exit(), 2000);
}

/**
 * Checks to see if the qtumd port is still in use.
 * This was necessary when switching from the dapp to the qtum wallet.
 */
function checkQtumPort() {
  const port = isMainnet() ? Config.RPC_PORT_MAINNET : Config.RPC_PORT_TESTNET;
  portscanner.checkPortStatus(port, Config.HOSTNAME, (err, status) => {
    if (err) {
      getLogger().error(`Error: qtumd: ${err.message}`);
    }
    if (status === 'closed') {
      clearInterval(shutdownInterval);

      // Slight delay before sending qtumd killed signal
      setTimeout(() => EmitterHelper.onQtumKilled(), 1500);
    } else {
      getLogger().debug('Waiting for qtumd to shut down.');
    }
  });
}

/**
 * Kills the running qtum process using the stop command.
 * @param {boolean} emitEvent Should emit an event when qtum is fully shutdown.
 */
function killQtumProcess(emitEvent) {
  if (qtumProcess) {
    const flags = [`-rpcuser=${Config.RPC_USER}`, `-rpcpassword=${getRPCPassword()}`];
    if (!isMainnet()) {
      flags.push(`-${getEnvConfig().network}`);
    }
    flags.push('stop');

    const qtumcliPath = `${getEnvConfig().qtumPath}/${BIN_TYPE.QTUM_CLI}`;
    const res = spawnSync(qtumcliPath, flags);
    const code = res.status;
    if (res.stdout) {
      getLogger().debug(`qtumd stopped with code ${code}: ${res.stdout}`);
    } else if (res.stderr) {
      getLogger().error(`qtumd stopped with code ${code}: ${res.stderr}`);
      if (res.error) {
        throw Error(res.error.message);
      }
    }

    // Repeatedly check if qtum port is in use
    if (emitEvent) {
      shutdownInterval = setInterval(checkQtumPort, 500);
    }
  }
}

function exit(signal) {
  getLogger().info(`Received ${signal}, exiting...`);

  try {
    killQtumProcess(false);
  } catch (err) {
    // catch error so exit can still call process.exit()
  }

  // add delay to give some time to write to log file
  setTimeout(() => process.exit(), 500);
}

process.on('SIGINT', exit);
process.on('SIGTERM', exit);
process.on('SIGHUP', exit);
process.on('uncaughtException', exit);

module.exports = {
  getQtumProcess,
  startServer,
  startServices,
  killQtumProcess,
  startQtumWallet,
  exit,
};
