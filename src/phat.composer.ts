// for deploying dRuntime and phala anchor contracts
import * as crypto from 'crypto';
import { join } from 'path';
import * as fs from 'fs';
import { ApiPromise, WsProvider, Keyring } from '@polkadot/api';
import { ContractPromise } from '@polkadot/api-contract';
import { typeDefinitions } from '@polkadot/types';
import * as Phala from '@phala/sdk';
import * as utils from './utils/oracle.utils';
import {
  TxQueue,
  blockBarrier,
  hex,
  checkUntil,
  checkUntilEq,
} from './phat.utils';
import { ConfigService } from '@nestjs/config';
import { ethers } from 'ethers';
import Web3 from 'web3';

export function loadFatContract(contractPath: string) {
  const f = fs.readFileSync(contractPath);
  const contract = JSON.parse(f.toString());
  const constructor = contract.V3.spec.constructors.find(
    (c: any) => c.label === 'default',
  ).selector;
  const { name } = contract.contract;
  const { wasm } = contract.source;
  const { hash } = contract.source;
  return {
    hash,
    wasm,
    contract,
    constructor,
    name,
    address: '',
  };
}

export function loadAnchorArtifact(path: string) {
  return require(path);
}

export async function configFatContract(
  api,
  txqueue,
  signer,
  pruntimeUrl,
  artifact,
  name,
  args,
) {
  // connect to pruntime
  const prpc = Phala.createPruntimeApi(pruntimeUrl);
  const connectedWorker = hex((await prpc.getInfo({})).publicKey);
  console.log('Connected worker:', connectedWorker);

  const newApi = await api.clone().isReady;
  console.log(newApi);
  const t = await Phala.create({
    api: newApi,
    baseURL: pruntimeUrl,
    contractId: artifact.address,
    autoDeposit: true,
  });
  console.log(t);
  let contract = new ContractPromise(
    t.api,
    artifact.contract,
    artifact.address,
  );
  console.log('Fat Contract: connected', contract);

  // set up the contracts
  await txqueue.submit(
    // target_chain_rpc: Option<String>,
    // anchor_contract_addr: Option<H160>,
    // web2_api_url_prefix: Option<String>,
    // api_key: Option<String>,
    contract.api.tx.call(name, args),
    signer,
    true,
  );

  // wait for the worker to sync to the bockchain
  await blockBarrier(api, prpc);

  console.log('Config finished');
}

export async function deployFatContract(
  mnemonic: string,
  clusterId: string,
  chainUrl: string,
  pruntimeUrl: string,
  contractPath: string,
  config: any,
) {
  // Create a keyring instance
  const keyring = new Keyring({ type: 'sr25519' });

  // Prepare accounts
  const sponsor = keyring.addFromUri(mnemonic);

  const artifact = loadFatContract(contractPath);

  // connect to the chain
  const wsProvider = new WsProvider(chainUrl);
  console.log(wsProvider);
  const api = await ApiPromise.create({
    provider: wsProvider,
    types: {
      ...typeDefinitions.contracts.types,
      GistQuote: {
        username: 'String',
        accountId: 'AccountId',
      },
      ...Phala.types,
    },
  });
  const cert = await Phala.signCertificate({ api, pair: sponsor });

  const txqueue = new TxQueue(api);

  // connect to pruntime
  const prpc = Phala.createPruntimeApi(pruntimeUrl);
  const connectedWorker = hex((await prpc.getInfo({})).publicKey);
  console.log('Connected worker:', connectedWorker);

  // contracts
  const address = await submit(
    api,
    txqueue,
    sponsor,
    cert,
    artifact,
    clusterId,
    '',
  );
  artifact.address = address;
  console.log(address);

  await configFatContract(
    api,
    txqueue,
    sponsor,
    pruntimeUrl,
    artifact,
    'config',
    [
      config.target_chain_rpc, // saas3 protocol rpc
      config.anchor_contract_addr,
      config.web2_api_url_prefix,
      config.api_key,
    ],
  );

  await blockBarrier(api, prpc);

  console.log('Deployment finished');
  return address;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function submit(
  api,
  txqueue,
  account,
  cert,
  artifact,
  clusterId,
  salt,
) {
  salt = salt || hex(crypto.randomBytes(4));
  console.log('Contracts: uploading', artifact.name);

  // upload the contract
  await txqueue.submit(
    api.tx.phalaFatContracts.clusterUploadResource(
      clusterId,
      'InkCode',
      artifact.wasm,
    ),
    account,
  );

  // Not sure how much time it would take to sync the code into pruntime
  console.log(
    'Waiting the code to be synced into pruntime to estmate the instantiation',
  );
  await sleep(10000);
  console.log(`Contracts: ${artifact.name} uploaded`);

  console.log('Contracts: instantiating', artifact.name);
  const { events: deployEvents } = await txqueue.submit(
    api.tx.phalaFatContracts.instantiateContract(
      { WasmCode: artifact.hash },
      artifact.constructor,
      salt,
      clusterId,
      0,
      '10000000000000',
      null,
    ),
    account,
  );

  deployEvents.forEach((record) => {
    // Extract the phase, event and the event types
    const { event, phase } = record;
    const types = event.typeDef;

    // Show what we are busy with
    console.log(
      `\t${event.section}:${event.method}:: (phase=${phase.toString()})`,
    );

    // Loop through each of the parameters, displaying the type and data
    event.data.forEach((data, index) => {
      console.log(`\t\t\t${types[index].type}: ${data.toString()}`);
    });
  });

  const contractIds = deployEvents
    .filter(
      (ev) =>
        ev.event.section === 'phalaFatContracts' &&
        ev.event.method === 'Instantiating',
    )
    .map((ev) => ev.event.data[0].toString());
  console.log(contractIds);

  const numContracts = 1;
  console.assert(
    contractIds.length === numContracts,
    'Incorrect length:',
    `${contractIds.length} vs ${numContracts}`,
  );
  // eslint-disable-next-line prefer-destructuring
  artifact.address = contractIds[0];

  await checkUntilEq(
    async () =>
      (
        await api.query.phalaFatContracts.clusterContracts(clusterId)
      ).filter((c) => contractIds.includes(c.toString())).length,
    numContracts,
    60 * 1000,
  );

  console.log('Contracts: deployed');
  return artifact.address;
}

export async function deployWithWeb3(
  provider: string,
  sponsorMnemonic: string,
  abi: any,
  bytecode: any,
) {
  const web3 = new Web3(provider);
  let prikey = utils.getUserWallet(sponsorMnemonic, provider).privateKey;
  const accountFrom = {
    privateKey: prikey,
  };
  let signer = web3.eth.accounts.privateKeyToAccount(prikey);
  web3.eth.accounts.wallet.add(signer);

  const incrementer = new web3.eth.Contract(abi);
  const incrementerTx = incrementer.deploy({
    data: bytecode,
    arguments: [],
  });
  const tx = await web3.eth.accounts.signTransaction(
    {
      data: incrementerTx.encodeABI(),
      gas: await incrementerTx.estimateGas(),
      //gasPrice: web3.utils.toWei('1000', 'gwei'),
    },
    accountFrom.privateKey,
  );
  const receipt = await web3.eth.sendSignedTransaction(tx.rawTransaction);
  console.log(`Contract deployed at address: ${receipt.contractAddress}`);
  return { address: receipt.contractAddress, abi: abi };
}
