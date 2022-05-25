/* eslint-disable func-names */
/* global describe it beforeEach */
const hre = require('hardhat');
const { ethers } = require('hardhat');
const chai = require('chai');
const chaiAsPromised = require('chai-as-promised');

const weth9artifact = require('@ethereum-artifacts/weth9');

const relayAdaptHelper = require('../../../helpers/adapt/relay/relayadapt');
const babyjubjub = require('../../../helpers/logic/babyjubjub');
const MerkleTree = require('../../../helpers/logic/merkletree');
const { Note } = require('../../../helpers/logic/note');
const transaction = require('../../../helpers/logic/transaction');
const NoteRegistry = require('../../../helpers/logic/noteregistry');

chai.use(chaiAsPromised);

const { expect } = chai;

let snarkBypassSigner;
let treasuryAccount;
let testERC20;
let railgunLogic;
let weth9;
let relayAdapt;

describe('Adapt/Relay', () => {
  beforeEach(async () => {
    await hre.network.provider.request({
      method: 'hardhat_setBalance',
      params: ['0x000000000000000000000000000000000000dEaD', '0x56BC75E2D63100000'],
    });
    await hre.network.provider.request({
      method: 'hardhat_impersonateAccount',
      params: ['0x000000000000000000000000000000000000dEaD'],
    });
    snarkBypassSigner = await ethers.getSigner('0x000000000000000000000000000000000000dEaD');

    const accounts = await ethers.getSigners();
    [treasuryAccount] = accounts;

    const PoseidonT3 = await ethers.getContractFactory('PoseidonT3');
    const PoseidonT4 = await ethers.getContractFactory('PoseidonT4');
    const poseidonT3 = await PoseidonT3.deploy();
    const poseidonT4 = await PoseidonT4.deploy();

    const RailgunLogic = await ethers.getContractFactory('RailgunLogic', {
      libraries: {
        PoseidonT3: poseidonT3.address,
        PoseidonT4: poseidonT4.address,
      },
    });
    railgunLogic = await RailgunLogic.deploy();
    railgunLogic = railgunLogic.connect(snarkBypassSigner);
    await railgunLogic.initializeRailgunLogic(
      treasuryAccount.address,
      25n,
      25n,
      25n,
      treasuryAccount.address,
    );

    const TestERC20 = await ethers.getContractFactory('TestERC20');
    testERC20 = await TestERC20.deploy();
    await testERC20.transfer('0x000000000000000000000000000000000000dEaD', 2n ** 256n - 1n);
    testERC20 = testERC20.connect(snarkBypassSigner);
    await testERC20.approve(railgunLogic.address, 2n ** 256n - 1n);

    const WETH9 = new ethers.ContractFactory(
      weth9artifact.WETH9.abi,
      weth9artifact.WETH9.bytecode,
      accounts[0],
    );
    weth9 = await WETH9.deploy();

    const RelayAdapt = await ethers.getContractFactory('RelayAdapt');
    relayAdapt = await RelayAdapt.deploy(railgunLogic.address, weth9.address);
  });

  it('Should calculate adapt params', async function () {
    let loops = 1n;

    if (process.env.LONG_TESTS === 'extra') {
      this.timeout(5 * 60 * 60 * 1000);
      loops = 5n;
    } else if (process.env.LONG_TESTS === 'complete') {
      this.timeout(5 * 60 * 60 * 1000);
      loops = 10n;
    }

    for (let i = 0n; i < loops; i += 1n) {
      const merkletree = new MerkleTree();
      const spendingKey = babyjubjub.genRandomPrivateKey();
      const viewingKey = babyjubjub.genRandomPrivateKey();
      const token = ethers.utils.keccak256(
        ethers.BigNumber.from(i * loops).toHexString(),
      ).slice(0, 42);

      for (let j = 0n; j < i + 1n; j += 1n) {
        const notes = new Array(Number(i)).fill(1).map(
          // eslint-disable-next-line no-loop-func
          () => new Note(
            spendingKey,
            viewingKey,
            i * 10n ** 18n,
            babyjubjub.genRandomPoint(),
            BigInt(token),
          ),
        );

        merkletree.insertLeaves(notes.map((note) => note.hash));

        // eslint-disable-next-line no-await-in-loop
        const txs = await Promise.all(
          new Array(Number(j)).fill(1).map(() => transaction.dummyTransact(
            merkletree,
            0n,
            ethers.constants.AddressZero,
            ethers.constants.HashZero,
            notes,
            notes,
            new Note(0n, 0n, 0n, 0n, 0n),
            ethers.constants.AddressZero,
          )),
        );

        const additionalData = ethers.utils.keccak256(
          ethers.BigNumber.from(i * loops + 1n).toHexString(),
        ).slice(0, 42);

        // eslint-disable-next-line no-await-in-loop
        expect(await relayAdapt.getAdaptParams(txs, additionalData))
          .to.equal(relayAdaptHelper.getAdaptParams(txs, additionalData));
      }
    }
  });

  it('Should calculate relay adapt params', async function () {
    let loops = 1n;

    if (process.env.LONG_TESTS === 'extra') {
      this.timeout(5 * 60 * 60 * 1000);
      loops = 5n;
    } else if (process.env.LONG_TESTS === 'complete') {
      this.timeout(5 * 60 * 60 * 1000);
      loops = 10n;
    }

    for (let i = 0n; i < loops; i += 1n) {
      const merkletree = new MerkleTree();
      const spendingKey = babyjubjub.genRandomPrivateKey();
      const viewingKey = babyjubjub.genRandomPrivateKey();
      const token = ethers.utils.keccak256(
        ethers.BigNumber.from(i * loops).toHexString(),
      ).slice(0, 42);

      for (let j = 0n; j < i; j += 1n) {
        const notes = new Array(Number(i)).fill(1).map(
          // eslint-disable-next-line no-loop-func
          () => new Note(
            spendingKey,
            viewingKey,
            i * 10n ** 18n,
            babyjubjub.genRandomPoint(),
            BigInt(token),
          ),
        );

        merkletree.insertLeaves(notes.map((note) => note.hash));

        // eslint-disable-next-line no-await-in-loop
        const txs = await Promise.all(
          new Array(Number(j)).fill(1).map(() => transaction.dummyTransact(
            merkletree,
            0n,
            ethers.constants.AddressZero,
            ethers.constants.HashZero,
            notes,
            notes,
            new Note(0n, 0n, 0n, 0n, 0n),
            ethers.constants.AddressZero,
          )),
        );

        const random = BigInt(ethers.utils.keccak256(
          ethers.BigNumber.from(i * loops + 2n).toHexString(),
        ));
        const requireSuccess = i % 2n === 0n;
        const calls = new Array(j).fill({
          to: token,
          data: ethers.utils.keccak256(
            ethers.BigNumber.from(i * loops + 3n).toHexString(),
          ),
          value: i,
        });

        // eslint-disable-next-line no-await-in-loop
        expect(await relayAdapt.getRelayAdaptParams(
          txs,
          random,
          requireSuccess,
          calls,
        )).to.equal(relayAdaptHelper.getRelayAdaptParams(
          txs,
          random,
          requireSuccess,
          calls,
        ));
      }
    }
  });

  it('Should wrap+deposit, and unwrap+withdraw ETH', async () => {
    const merkletree = new MerkleTree();
    const wethnoteregistry = new NoteRegistry();

    const depositFee = BigInt((await railgunLogic.depositFee()).toHexString());
    const withdrawFee = BigInt((await railgunLogic.depositFee()).toHexString());

    const spendingKey = babyjubjub.genRandomPrivateKey();
    const viewingKey = babyjubjub.genRandomPrivateKey();

    let cumulativeBase = 0n;
    let cumulativeFee = 0n;

    const depositNote = new Note(
      spendingKey,
      viewingKey,
      1000n,
      babyjubjub.genRandomPoint(),
      weth9.address,
    );

    const calls = relayAdaptHelper.formatCalls([
      await relayAdapt.populateTransaction.wrapAllBase(),
      await relayAdapt.populateTransaction.deposit(
        [{
          tokenType: 0n,
          tokenAddress: weth9.address,
          tokenSubID: 0n,
        }],
        await depositNote.encryptRandom(),
        depositNote.notePublicKey,
      ),
    ]);

    await relayAdapt.multicall(true, calls, { value: depositNote.value });

    const [depositTxBase, depositTxFee] = transaction.getFee(depositNote.value, true, depositFee);

    cumulativeBase += depositTxBase;
    cumulativeFee += depositTxFee;

    expect(await weth9.balanceOf(railgunLogic.address)).to.equal(cumulativeBase);
    expect(await weth9.balanceOf(treasuryAccount.address)).to.equal(cumulativeFee);
  });
});
