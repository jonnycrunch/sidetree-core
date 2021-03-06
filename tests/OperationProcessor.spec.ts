import BatchFile from '../src/BatchFile';
import Cryptography from '../src/lib/Cryptography';
import MockCas from './mocks/MockCas';
import OperationGenerator from './generators/OperationGenerator';
import { Cas } from '../src/Cas';
import { createOperationProcessor } from '../src/OperationProcessor';
import { DidDocument } from '@decentralized-identity/did-common-typescript';
import DidPublicKey from '../src/lib/DidPublicKey';
import { Operation } from '../src/Operation';
import { initializeProtocol } from '../src/Protocol';

/**
 * Creates a batch file with single operation given operation buffer,
 * then adds the batch file to the given CAS.
 * @returns The operation in the batch file added in the form of a Operation.
 */
async function addBatchFileOfOneOperationToCas (
  opBuf: Buffer,
  cas: Cas,
  transactionNumber: number,
  transactionTime: number,
  operationIndex: number): Promise<Operation> {
  const operations: Buffer[] = [ opBuf ];
  const batchBuffer = BatchFile.fromOperations(operations).toBuffer();
  const batchFileAddress = await cas.write(batchBuffer);
  const resolvedTransaction = {
    transactionNumber,
    transactionTime,
    transactionTimeHash: 'unused',
    anchorFileHash: 'unused',
    batchFileHash: batchFileAddress
  };

  const op = Operation.create(opBuf, resolvedTransaction, operationIndex);
  return op;
}

async function createUpdateSequence (
  did: string,
  createOp: Operation,
  cas: Cas,
  numberOfUpdates:
  number,
  privateKey: any): Promise<Operation[]> {

  const ops = new Array(createOp);
  const opHashes = new Array(createOp.getOperationHash());

  for (let i = 0; i < numberOfUpdates; ++i) {
    const mostRecentVersion = opHashes[i];
    const updatePayload = {
      did,
      operationNumber: i + 1,
      previousOperationHash: mostRecentVersion,
      patch: [{
        op: 'replace',
        path: '/publicKey/1',
        value: {
          id: '#key2',
          type: 'RsaVerificationKey2018',
          owner: 'did:sidetree:updateid' + i,
          publicKeyPem: process.hrtime() // Some dummy value that's not used.
        }
      }]
    };

    const updateOperationBuffer = await OperationGenerator.generateUpdateOperation(updatePayload, '#key1', privateKey);
    const updateOp = await addBatchFileOfOneOperationToCas(
      updateOperationBuffer,
      cas,
      i + 1,   // transaction Number
      i + 1,   // transactionTime
      0        // operation index
      );
    ops.push(updateOp);

    const updateOpHash = updateOp.getOperationHash();
    opHashes.push(updateOpHash);
  }

  return ops;
}

function getFactorial (n: number): number {
  let factorial = 1;
  for (let i = 2 ; i <= n ; ++i) {
    factorial *= i;
  }
  return factorial;
}

// Return a permutation of a given size with a specified index among
// all possible permutations. For example, there are 5! = 120 permutations
// of size 5, so by passing index values 0..119 we can enumerate all
// permutations
function getPermutation (size: number, index: number): Array<number> {
  const permutation: Array<number> = [];

  for (let i = 0 ; i < size ; ++i) {
    permutation.push(i);
  }

  for (let i = 0 ; i < size ; ++i) {
    const j = i + Math.floor(index / getFactorial(size - i - 1));
    index = index % getFactorial(size - i - 1);

    const t = permutation[i];
    permutation[i] = permutation[j];
    permutation[j] = t;
  }

  return permutation;
}

function getPublicKey (didDocument: DidDocument, keyId: string): DidPublicKey | undefined {
  for (let i = 0; i < didDocument.publicKey.length; i++) {
    const publicKey = didDocument.publicKey[i];

    if (publicKey.id && publicKey.id.endsWith(keyId)) {
      return publicKey;
    }
  }

  return undefined;
}

describe('OperationProessor', async () => {
  initializeProtocol('protocol-test.json');

  // Load the DID Document template.
  const didDocumentTemplate = require('./json/didDocumentTemplate.json');
  const didMethodName = 'did:sidetree:';

  let cas = new MockCas();
  let operationProcessor = createOperationProcessor(cas, didMethodName);
  let createOp: Operation | undefined;
  let publicKey: any;
  let privateKey: any;
  let did: string;

  beforeEach(async () => {
    [publicKey, privateKey] = await Cryptography.generateKeyPairHex('#key1'); // Generate a unique key-pair used for each test.

    cas = new MockCas();
    operationProcessor = createOperationProcessor(cas, didMethodName); // TODO: add a clear method to avoid double initialization.

    const createOperationBuffer = await OperationGenerator.generateCreateOperationBuffer(didDocumentTemplate, publicKey, privateKey);
    createOp = await addBatchFileOfOneOperationToCas(createOperationBuffer, cas, 0, 0, 0);
    const createOpHash = createOp.getOperationHash();
    await operationProcessor.process(createOp);
    did = didMethodName + createOpHash;
  });

  it('should return a DID Document for resolve(did) for a registered DID', async () => {
    const didDocument = await operationProcessor.resolve(did);

    // TODO: can we get the raw json from did? if so, we can write a better test.
    // This is a poor man's version based on public key properties
    expect(didDocument).toBeDefined();
    const publicKey2 = getPublicKey(didDocument!, 'key2');
    expect(publicKey2).toBeDefined();
    expect(publicKey2!.owner).toBeUndefined();
  });

  it('should process updates correctly', async () => {
    const numberOfUpdates = 10;
    const ops = await createUpdateSequence(did, createOp!, cas, numberOfUpdates, privateKey);

    for (let i = 0 ; i < ops.length ; ++i) {
      await operationProcessor.process(ops[i]);
    }

    const didDocument = await operationProcessor.resolve(did);
    expect(didDocument).toBeDefined();
    const publicKey2 = getPublicKey(didDocument!, 'key2');
    expect(publicKey2).toBeDefined();
    expect(publicKey2!.owner).toBeDefined();
    expect(publicKey2!.owner!).toEqual('did:sidetree:updateid' + (numberOfUpdates - 1));
  });

  it('should correctly process updates in reverse order', async () => {
    const numberOfUpdates = 10;
    const ops = await createUpdateSequence(did, createOp!, cas, numberOfUpdates, privateKey);

    for (let i = numberOfUpdates ; i >= 0 ; --i) {
      await operationProcessor.process(ops[i]);
    }
    const didDocument = await operationProcessor.resolve(did);
    expect(didDocument).toBeDefined();
    const publicKey2 = getPublicKey(didDocument!, 'key2');
    expect(publicKey2).toBeDefined();
    expect(publicKey2!.owner).toBeDefined();
    expect(publicKey2!.owner!).toEqual('did:sidetree:updateid' + (numberOfUpdates - 1));
  });

  it('should correctly process updates in every (5! = 120) order', async () => {
    const numberOfUpdates = 4;
    const ops = await createUpdateSequence(did, createOp!, cas, numberOfUpdates, privateKey);

    const numberOfOps = ops.length;
    const numberOfPermutations = getFactorial(numberOfOps);
    for (let i = 0 ; i < numberOfPermutations; ++i) {
      const permutation = getPermutation(numberOfOps, i);
      operationProcessor = createOperationProcessor(cas, 'did:sidetree:'); // Reset

      for (let i = 0 ; i < numberOfOps ; ++i) {
        const opIdx = permutation[i];
        await operationProcessor.process(ops[opIdx]);
      }
      const didDocument = await operationProcessor.resolve(did);
      expect(didDocument).toBeDefined();
      const publicKey2 = getPublicKey(didDocument!, 'key2');
      expect(publicKey2).toBeDefined();
      expect(publicKey2!.owner).toBeDefined();
      expect(publicKey2!.owner!).toEqual('did:sidetree:updateid' + (numberOfUpdates - 1));
    }
  });

  it('should not resolve the DID if its create operation failed signature validation.', async () => {
    // Generate a create operation with an invalid signature.
    const [publicKey, privateKey] = await Cryptography.generateKeyPairHex('#key1');
    const operation = await OperationGenerator.generateCreateOperation(didDocumentTemplate, publicKey, privateKey);
    operation.signature = 'AnInvalidSignature';

    // Create and upload the batch file with the invalid operation.
    const operationBuffer = Buffer.from(JSON.stringify(operation));
    const createOperation = await addBatchFileOfOneOperationToCas(operationBuffer, cas, 1, 0, 0);

    // Trigger processing of the operation.
    await operationProcessor.process(createOperation);
    const did = didMethodName + createOperation.getOperationHash();

    // Attempt to resolve the DID and validate the outcome.
    const didDocument = await operationProcessor.resolve(did);
    expect(didDocument).toBeUndefined();
  });
});
