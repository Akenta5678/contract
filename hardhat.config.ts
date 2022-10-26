import { HardhatUserConfig, task } from 'hardhat/config';
import '@nomicfoundation/hardhat-chai-matchers';
import '@nomiclabs/hardhat-ethers';
import '@nomiclabs/hardhat-etherscan';
import '@typechain/hardhat';
import 'hardhat-gas-reporter';
import 'solidity-coverage';
import 'hardhat-local-networks-config-plugin';
import { time } from '@nomicfoundation/hardhat-network-helpers';

import type { HardhatRuntimeEnvironment } from 'hardhat/types';

import { poseidonContract } from 'circomlibjs';
import mocharc from './.mocharc.json';

const config: HardhatUserConfig = {
  defaultNetwork: 'hardhat',
  solidity: {
    version: '0.8.16',
    settings: {
      optimizer: {
        enabled: true,
        runs: 1600,
      },
      outputSelection: {
        '*': {
          '*': ['storageLayout'],
        },
      },
    },
  },
  mocha: mocharc,
  gasReporter: {
    enabled: true,
    currency: 'USD',
  },
  etherscan: {
    apiKey: process.env.ETHERSCAN_API_KEY,
  },
};

/**
 * Overwrites build artifacts to inject generated bytecode
 *
 * @param hre - hardhat runtime environment
 * @param contractName - contract name to overwrite
 * @param bytecode - bytecode to inject
 * @returns promise for completion
 */
async function overwriteArtifact(
  hre: HardhatRuntimeEnvironment,
  contractName: string,
  bytecode: string,
): Promise<void> {
  const artifact = await hre.artifacts.readArtifact(contractName);
  await hre.artifacts.saveArtifactAndDebugFile({
    ...artifact,
    bytecode,
  });
}

task(
  'compile',
  'Compiles the entire project, building all artifacts and injecting precompiled artifacts',
  async (taskArguments, hre, runSuper) => {
    await runSuper();
    await overwriteArtifact(hre, 'PoseidonT3', poseidonContract.createCode(2));
    await overwriteArtifact(hre, 'PoseidonT4', poseidonContract.createCode(3));
  },
);

task('test', 'Runs test suite')
  .addOptionalParam(
    'longtests',
    'no = execute shorter tests; no = full test suite enabled (default: yes)',
  )
  .setAction(async (taskArguments: { longtests: string }, hre, runSuper) => {
    if (taskArguments.longtests === 'no' || taskArguments.longtests === 'yes') {
      process.env.LONG_TESTS = taskArguments.longtests;
    } else if (process.env.LONG_TESTS !== 'no') {
      process.env.LONG_TESTS = 'yes';
    }
    await runSuper();
  });

task('accounts', 'Prints the list of accounts', async (taskArguments, hre) => {
  const accounts = await hre.ethers.getSigners();
  accounts.forEach((account) => {
    console.log(account.address);
  });
});

task('deploy:test', 'Deploy full deployment for testing purposes', async (taskArguments, hre) => {
  await hre.run('run', { script: 'scripts/deploy_test.ts' });
});

task(
  'forktoken',
  'Gives 100m balance to address[0] when running in fork mode',
  async (taskArguments, hre) => {
    await hre.run('run', { script: 'scripts/grant_balance.js' });
  },
);

task('fastforward', 'Fast forwards time')
  .addParam('days', 'Days to fast forward (accepts decimal values)')
  .setAction(async (taskArguments: { days: string }) => {
    await time.increase(86400 * Number(taskArguments.days));
    console.log(`Fast forwarded ${taskArguments.days} days`);
  });

export default config;
