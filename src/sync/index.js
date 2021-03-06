/* eslint-disable no-underscore-dangle */

const _ = require('lodash');
const { BigNumber } = require('bignumber.js');

const updateTransactions = require('./update-transactions');
const { getInstance } = require('../qclient');
const { TOKEN, STATUS, WITHDRAW_TYPE } = require('../constants');
const { getContractMetadata } = require('../config');
const { db } = require('../db');
const DBHelper = require('../db/db-helper');
const { getLogger } = require('../utils/logger');
const { publishSyncInfo } = require('../graphql/subscriptions');
const Topic = require('../models/topic');
const CentralizedOracle = require('../models/centralized-oracle');
const DecentralizedOracle = require('../models/decentralized-oracle');
const Vote = require('../models/vote');
const OracleResultSet = require('../models/oracle-result-set');
const FinalResultSet = require('../models/final-result-set');
const Withdraw = require('../models/withdraw');

const SYNC_START_DELAY = 5000;
const REMOVE_HEX_PREFIX = true;
let contractMetadata;

// Returns the starting block to start syncing
const getStartBlock = async () => {
  let startBlock = contractMetadata.contractDeployedBlock;
  if (!startBlock) {
    throw Error('Missing startBlock in contract metadata.');
  }

  const blocks = await db.Blocks.cfind({}).sort({ blockNum: -1 }).limit(1).exec();
  if (blocks.length > 0) {
    startBlock = Math.max(blocks[0].blockNum + 1, startBlock);
  }

  return startBlock;
};

const syncTopicCreated = async (currentBlockNum) => {
  let result;
  try {
    result = await getInstance().searchLogs(
      currentBlockNum, currentBlockNum, contractMetadata.EventFactory.address,
      [contractMetadata.EventFactory.TopicCreated], contractMetadata, REMOVE_HEX_PREFIX,
    );
  } catch (err) {
    throw Error(`searchlog TopicCreated: ${err.message}`);
  }

  const topicEventPromises = [];
  _.forEach(result, (event, index) => {
    const blockNum = event.blockNumber;
    const txid = event.transactionHash;

    _.forEachRight(event.log, (entry) => {
      if (entry._eventName === 'TopicCreated') {
        topicEventPromises.push(new Promise(async (resolve) => {
          try {
            const topic = new Topic(blockNum, txid, entry).translate();
            // Update existing mutated Topic or insert new
            if (await DBHelper.getCount(db.Topics, { txid }) > 0) {
              const foundTopic = await DBHelper.findOne(db.Topics, { txid }, ['language']);
              if (foundTopic.language) {
                topic.language = foundTopic.language;
              }
              DBHelper.updateTopicByQuery(db.Topics, { txid }, topic);
            } else {
              DBHelper.insertTopic(db.Topics, topic);
            }

            resolve();
          } catch (err) {
            getLogger().error(`insert TopicEvent: ${err.message}`);
            resolve();
          }
        }));
      }
    });
  });

  await Promise.all(topicEventPromises);
};

const syncCentralizedOracleCreated = async (currentBlockNum) => {
  let result;
  try {
    result = await getInstance().searchLogs(
      currentBlockNum, currentBlockNum, contractMetadata.EventFactory.address,
      [contractMetadata.OracleFactory.CentralizedOracleCreated], contractMetadata, REMOVE_HEX_PREFIX,
    );
  } catch (err) {
    throw Error(`searchlog CentralizedOracleCreated: ${err.message}`);
  }

  const cOraclePromises = [];
  _.forEach(result, (event, index) => {
    const blockNum = event.blockNumber;
    const txid = event.transactionHash;

    _.forEachRight(event.log, (rawLog) => {
      if (rawLog._eventName === 'CentralizedOracleCreated') {
        cOraclePromises.push(new Promise(async (resolve) => {
          try {
            const cOracle = new CentralizedOracle(blockNum, txid, rawLog).translate();

            // Insert existing Topic info into Oracle
            const topic = await DBHelper.findOne(db.Topics, { address: cOracle.topicAddress }, ['name', 'options', 'hashId', 'language']);
            cOracle.name = topic.name;
            cOracle.options = topic.options;
            cOracle.hashId = topic.hashId;
            cOracle.language = topic.language;

            // Update existing mutated Oracle or insert new
            if (await DBHelper.getCount(db.Oracles, { txid }) > 0) {
              DBHelper.updateOracleByQuery(db.Oracles, { txid }, cOracle);
            } else {
              DBHelper.insertOracle(db.Oracles, cOracle);
            }

            resolve();
          } catch (err) {
            getLogger().error(`insert CentralizedOracle: ${err.message}`);
            resolve();
          }
        }));
      }
    });
  });

  await Promise.all(cOraclePromises);
};

const syncDecentralizedOracleCreated = async (currentBlockNum, currentBlockTime) => {
  let result;
  try {
    result = await getInstance().searchLogs(
      currentBlockNum, currentBlockNum, [],
      contractMetadata.OracleFactory.DecentralizedOracleCreated, contractMetadata, REMOVE_HEX_PREFIX,
    );
  } catch (err) {
    throw Error(`searchlog DecentralizedOracleCreated: ${err.message}`);
  }

  const dOraclePromises = [];
  _.forEach(result, (event, index) => {
    const blockNum = event.blockNumber;
    const txid = event.transactionHash;

    _.forEachRight(event.log, (rawLog) => {
      if (rawLog._eventName === 'DecentralizedOracleCreated') {
        dOraclePromises.push(new Promise(async (resolve) => {
          try {
            const dOracle = new DecentralizedOracle(blockNum, txid, rawLog).translate();

            const topic = await DBHelper.findOne(db.Topics, { address: dOracle.topicAddress }, ['name', 'options', 'language']);
            dOracle.name = topic.name;
            dOracle.options = topic.options;
            dOracle.startTime = currentBlockTime;
            dOracle.language = topic.language;

            await db.Oracles.insert(dOracle);
            resolve();
          } catch (err) {
            getLogger().error(`insert DecentralizedOracleCreated: ${err.message}`);
            resolve();
          }
        }));
      }
    });
  });

  await Promise.all(dOraclePromises);
};

const syncOracleResultVoted = async (currentBlockNum) => {
  let result;
  try {
    result = await getInstance().searchLogs(
      currentBlockNum, currentBlockNum, [],
      contractMetadata.CentralizedOracle.OracleResultVoted, contractMetadata, REMOVE_HEX_PREFIX,
    );
  } catch (err) {
    throw Error(`searchlog OracleResultVoted: ${err.message}`);
  }

  const votedPromises = [];
  _.forEach(result, (event, index) => {
    const blockNum = event.blockNumber;
    const txid = event.transactionHash;

    _.forEachRight(event.log, (rawLog) => {
      if (rawLog._eventName === 'OracleResultVoted') {
        votedPromises.push(new Promise(async (resolve) => {
          try {
            const vote = new Vote(blockNum, txid, rawLog).translate();

            // Add Topic address to Vote
            const oracle = await DBHelper.findOne(db.Oracles, { address: vote.oracleAddress });
            vote.topicAddress = oracle.topicAddress;
            await db.Votes.insert(vote);

            // Update Topic balance
            const voteBn = new BigNumber(vote.amount);
            const topic = await DBHelper.findOne(db.Topics, { address: oracle.topicAddress });
            switch (vote.token) {
              case TOKEN.QTUM: {
                topic.qtumAmount[vote.optionIdx] =
                  new BigNumber(topic.qtumAmount[vote.optionIdx]).plus(voteBn).toString(10);
                await DBHelper.updateObjectByQuery(
                  db.Topics,
                  { address: topic.address },
                  { qtumAmount: topic.qtumAmount },
                );
                break;
              }
              case TOKEN.BOT: {
                topic.botAmount[vote.optionIdx] =
                  new BigNumber(topic.botAmount[vote.optionIdx]).plus(voteBn).toString(10);
                await DBHelper.updateObjectByQuery(
                  db.Topics,
                  { address: topic.address },
                  { botAmount: topic.botAmount },
                );
                break;
              }
              default: {
                throw Error(`Invalid token type: ${vote.token}`);
              }
            }

            // Update Oracle balance
            // Check for token match first because we don't want to increment the COracle's amounts with the Set Result
            // BOT. Setting the result creates an OracleResultVoted event and takes place in the COracle contract.
            if (oracle.token === vote.token) {
              oracle.amounts[vote.optionIdx] = new BigNumber(oracle.amounts[vote.optionIdx]).plus(voteBn).toString(10);
              await DBHelper.updateObjectByQuery(db.Oracles, { address: oracle.address }, { amounts: oracle.amounts });
            }

            resolve();
          } catch (err) {
            getLogger().error(`insert OracleResultVoted: ${err.message}`);
            resolve();
          }
        }));
      }
    });
  });

  await Promise.all(votedPromises);
};

const syncOracleResultSet = async (currentBlockNum) => {
  let result;
  try {
    result = await getInstance().searchLogs(
      currentBlockNum, currentBlockNum, [],
      contractMetadata.CentralizedOracle.OracleResultSet, contractMetadata, REMOVE_HEX_PREFIX,
    );
  } catch (err) {
    throw Error(`searchlog OracleResultSet: ${err.message}`);
  }

  const resultSetPromises = [];
  _.forEach(result, (event, index) => {
    const blockNum = event.blockNumber;
    const txid = event.transactionHash;
    const fromAddress = event.from;

    _.forEachRight(event.log, (rawLog) => {
      if (rawLog._eventName === 'OracleResultSet') {
        resultSetPromises.push(new Promise(async (resolve) => {
          try {
            const resultSet = new OracleResultSet(blockNum, txid, fromAddress, rawLog).translate();

            // Add Topic address to ResultSet
            const oracle = await DBHelper.findOne(db.Oracles, { address: resultSet.oracleAddress }, ['topicAddress']);
            resultSet.topicAddress = oracle.topicAddress;
            await db.ResultSets.insert(resultSet);

            // Update Oracle status
            await db.Oracles.update(
              { address: resultSet.oracleAddress },
              { $set: { resultIdx: resultSet.resultIdx, status: STATUS.PENDING } }, {},
            );
            resolve();
          } catch (err) {
            getLogger().error(`insert OracleResultSet: ${err.message}`);
            resolve();
          }
        }));
      }
    });
  });

  await Promise.all(resultSetPromises);
};

const syncFinalResultSet = async (currentBlockNum) => {
  let result;
  try {
    result = await getInstance().searchLogs(
      currentBlockNum, currentBlockNum, [],
      contractMetadata.TopicEvent.FinalResultSet, contractMetadata, REMOVE_HEX_PREFIX,
    );
  } catch (err) {
    throw Error(`searchlog FinalResultSet: ${err.message}`);
  }

  const finalResultSetPromises = [];
  _.forEach(result, (event, index) => {
    const blockNum = event.blockNumber;
    const txid = event.transactionHash;
    const fromAddress = event.from;

    _.forEachRight(event.log, (rawLog) => {
      if (rawLog._eventName === 'FinalResultSet') {
        finalResultSetPromises.push(new Promise(async (resolve) => {
          try {
            const finalResultSet = new FinalResultSet(blockNum, txid, fromAddress, rawLog).translate();
            await db.ResultSets.insert(finalResultSet);

            // Update statuses to withdraw
            await db.Topics.update(
              { address: finalResultSet.topicAddress },
              { $set: { resultIdx: finalResultSet.resultIdx, status: STATUS.WITHDRAW } },
            );
            await db.Oracles.update(
              { topicAddress: finalResultSet.topicAddress },
              { $set: { status: STATUS.WITHDRAW } }, { multi: true },
            );

            resolve();
          } catch (err) {
            getLogger().error(`insert FinalResultSet: ${err.message}`);
            resolve();
          }
        }));
      }
    });
  });

  await Promise.all(finalResultSetPromises);
};

const syncWinningsWithdrawn = async (currentBlockNum) => {
  let result;
  try {
    result = await getInstance().searchLogs(
      currentBlockNum, currentBlockNum, [],
      contractMetadata.TopicEvent.WinningsWithdrawn, contractMetadata, REMOVE_HEX_PREFIX,
    );
  } catch (err) {
    throw Error(`searchlog WinningsWithdrawn: ${err.message}`);
  }

  const winningsWithdrawnPromises = [];
  _.forEach(result, (event, index) => {
    const blockNum = event.blockNumber;
    const txid = event.transactionHash;
    const contractAddress = event.contractAddress;

    _.forEachRight(event.log, (rawLog) => {
      if (rawLog._eventName === 'WinningsWithdrawn') {
        winningsWithdrawnPromises.push(new Promise(async (resolve) => {
          try {
            const withdraw = new Withdraw(blockNum, txid, contractAddress, rawLog, WITHDRAW_TYPE.WINNINGS).translate();
            await db.Withdraws.insert(withdraw);

            resolve();
          } catch (err) {
            getLogger().error(`insert WinningsWithdrawn: ${err.message}`);
            resolve();
          }
        }));
      }
    });
  });

  await Promise.all(winningsWithdrawnPromises);
};

const syncEscrowWithdrawn = async (currentBlockNum) => {
  let result;
  try {
    result = await getInstance().searchLogs(
      currentBlockNum, currentBlockNum, [],
      contractMetadata.AddressManager.EscrowWithdrawn, contractMetadata, REMOVE_HEX_PREFIX,
    );
  } catch (err) {
    throw Error(`searchlog EscrowWithdrawn: ${err.message}`);
  }

  const escrowWithdrawnPromises = [];
  _.forEach(result, (event, index) => {
    const blockNum = event.blockNumber;
    const txid = event.transactionHash;

    _.forEachRight(event.log, (rawLog) => {
      if (rawLog._eventName === 'EscrowWithdrawn') {
        escrowWithdrawnPromises.push(new Promise(async (resolve) => {
          try {
            const withdraw = new Withdraw(blockNum, txid, undefined, rawLog, WITHDRAW_TYPE.ESCROW).translate();
            await db.Withdraws.insert(withdraw);

            resolve();
          } catch (err) {
            getLogger().error(`insert EscrowWithdrawn: ${err.message}`);
            resolve();
          }
        }));
      }
    });
  });

  await Promise.all(escrowWithdrawnPromises);
};

// Update all Centralized and Decentralized Oracles statuses that are passed the endTime
const updateOraclesDoneVoting = async (currentBlockTime) => {
  try {
    await db.Oracles.update(
      { endTime: { $lt: currentBlockTime }, status: STATUS.VOTING },
      { $set: { status: STATUS.WAITRESULT } },
      { multi: true },
    );
  } catch (err) {
    getLogger().error(`updateOraclesDoneVoting: ${err.message}`);
  }
};

// Update Centralized Oracles to Open Result Set that are passed the resultSetEndTime
const updateCOraclesDoneResultSet = async (currentBlockTime) => {
  try {
    await db.Oracles.update(
      { resultSetEndTime: { $lt: currentBlockTime }, token: TOKEN.QTUM, status: STATUS.WAITRESULT },
      { $set: { status: STATUS.OPENRESULTSET } },
      { multi: true },
    );
  } catch (err) {
    getLogger().error(`updateCOraclesDoneResultSet ${err.message}`);
  }
};

const insertBlock = async (currentBlockNum, currentBlockTime) => {
  try {
    await db.Blocks.insert({
      _id: currentBlockNum,
      blockNum: currentBlockNum,
      blockTime: currentBlockTime,
    });
    getLogger().debug(`Inserted block ${currentBlockNum}`);
  } catch (err) {
    getLogger().error(`insert Block: ${err.message}`);
  }
};

// Delay then startSync
const delayThenSync = (delay, shouldUpdateLocalTxs) => {
  getLogger().debug('sleep');
  setTimeout(() => {
    startSync(shouldUpdateLocalTxs); // eslint-disable-line no-use-before-define
  }, delay);
};

/*
* Starts the sync logic. It will loop indefinitely until cancelled.
* @param shouldUpdateLocalTxs {Boolean} Should it update the local txs or not.
*/
const startSync = async (shouldUpdateLocalTxs) => {
  contractMetadata = getContractMetadata();

  const currentBlockNum = await getStartBlock();
  let currentBlockTime;
  try {
    const currentBlockHash = await getInstance().getBlockHash(currentBlockNum);
    currentBlockTime = (await getInstance().getBlock(currentBlockHash)).time;
    if (currentBlockTime <= 0) {
      throw Error(`Invalid blockTime: ${currentBlockTime}`);
    }
  } catch (err) {
    if (err.message === 'Block height out of range') {
      // Add delay since trying to parse a future block
      delayThenSync(SYNC_START_DELAY, shouldUpdateLocalTxs);
      return;
    }
    throw Error(`getBlockHash or getBlock: ${err.message}`);
  }

  getLogger().debug(`Syncing block ${currentBlockNum}`);

  if (shouldUpdateLocalTxs) {
    await updateTransactions(currentBlockNum);
    getLogger().debug('Updated local txs');
  }

  await syncTopicCreated(currentBlockNum);
  await syncCentralizedOracleCreated(currentBlockNum);
  await syncDecentralizedOracleCreated(currentBlockNum, currentBlockTime);
  await syncOracleResultVoted(currentBlockNum);
  await syncOracleResultSet(currentBlockNum);
  await syncFinalResultSet(currentBlockNum);
  await syncWinningsWithdrawn(currentBlockNum);
  await syncEscrowWithdrawn(currentBlockNum);
  await updateOraclesDoneVoting(currentBlockTime);
  await updateCOraclesDoneResultSet(currentBlockTime);
  await insertBlock(currentBlockNum, currentBlockTime);

  // Send syncInfo subscription message
  await publishSyncInfo(currentBlockNum, currentBlockTime);

  // No delay if next block is already confirmed
  delayThenSync(0, shouldUpdateLocalTxs);
};

module.exports = { startSync };

/* eslint-enable no-underscore-dangle */
