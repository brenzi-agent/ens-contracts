import hre from 'hardhat'
import {
  getAddress,
  keccak256,
  labelhash,
  toHex,
  zeroAddress,
  zeroHash,
} from 'viem'
import { describe, expect, it } from 'vitest'

import { DAY } from '../fixtures/constants.js'
import {
  AMPLE_ALLOWANCE,
  deployNamesV2,
  FAR_FUTURE,
  MIN_REGISTRATION,
  node,
  registration,
  signIntent,
  TLD_NODE,
  withConsent,
} from './fixtures/namesV2.js'

const connection = await hre.network.connect()
const publicClient = await connection.viem.getPublicClient()
const [
  ownerClient,
  guardianClient,
  registrarClient,
  aliceClient,
  bobClient,
  carolClient,
] = await connection.viem.getWalletClients()
const owner = ownerClient.account
const guardian = guardianClient.account
const registrar = registrarClient.account
const alice = aliceClient.account
const bob = bobClient.account
const carol = carolClient.account

const GRACE = 90n * DAY
const ALICE_ID = BigInt(labelhash('alicename'))

async function fixture() {
  const f = await deployNamesV2(connection, {
    owner: owner.address,
    beneficiary: guardian.address,
  })
  await f.sponsor.write.setRegistrarAllowance(
    [registrar.address, AMPLE_ALLOWANCE],
    { account: guardian },
  )
  await f.controller.write.setPublicSalesOpen([true], { account: owner })
  await sponsored(f, registration('alicename', alice.address))
  return f
}
const load = () => connection.networkHelpers.loadFixture(fixture)

async function commit(controller: any, reg: any) {
  await controller.write.commit([await controller.read.makeCommitment([reg])], {
    account: registrar,
  })
}

async function sponsored(f: any, reg: any) {
  await commit(f.controller, reg)
  return f.sponsor.write.registerWithCredit(
    await withConsent(connection, f.sponsor, reg),
    { account: registrar },
  )
}

/** The owner's `RegisterName` signature, signed by `client`. */
const signRegistration = (
  client: any,
  sponsor: `0x${string}`,
  reg: any,
  deadline = FAR_FUTURE,
) =>
  signIntent(publicClient, client, 'SimplexSponsor', sponsor, 'RegisterName', {
    label: reg.label,
    owner: reg.owner,
    resolver: reg.resolver,
    data: reg.data,
    deadline,
  })

/**
 * Nobody can be made the holder of a name, or the owner of a registry node,
 * without agreeing to it: an address could otherwise be tied on chain to
 * content it never chose. Agreeing means being the caller, or signing.
 */
describe('recipient consent', () => {
  describe('registration', () => {
    it('the payable path registers to the caller only', async () => {
      const { controller } = await load()
      const forBob = registration('forbobname', bob.address)
      await controller.write.commit(
        [await controller.read.makeCommitment([forBob])],
        { account: alice },
      )
      await expect(
        controller.write.register([forBob], {
          account: alice,
          value: 10n ** 20n,
        }),
      ).toBeRevertedWithCustomError('OwnerMustBeCaller')

      const forAlice = registration('aliceown', alice.address)
      await controller.write.commit(
        [await controller.read.makeCommitment([forAlice])],
        { account: alice },
      )
      await controller.write.register([forAlice], {
        account: alice,
        value: 10n ** 20n,
      })
    })

    it('the sponsored path needs the owner signature', async () => {
      const { controller, sponsor } = await load()
      const reg = registration('nosigname', bob.address)
      await commit(controller, reg)
      await expect(
        sponsor.write.registerWithCredit([reg, FAR_FUTURE, '0x'], {
          account: registrar,
        }),
      ).toBeRevertedWithCustomError('InvalidSignature')
      // the registrar signing for the owner is no better
      await expect(
        sponsor.write.registerWithCredit(
          [
            reg,
            FAR_FUTURE,
            await signRegistration(registrarClient, sponsor.address, reg),
          ],
          { account: registrar },
        ),
      ).toBeRevertedWithCustomError('InvalidSignature')
    })

    it('a signature covers the label and everything written at registration', async () => {
      const { controller, sponsor, resolver } = await load()
      const signed = registration('signedname', bob.address, {
        resolver: resolver.address,
      })
      const sig = await signRegistration(bobClient, sponsor.address, signed)
      const tampered = [
        { ...signed, label: 'othername' },
        { ...signed, resolver: carol.address },
        {
          ...signed,
          data: [
            (await import('viem')).encodeFunctionData({
              abi: resolver.abi,
              functionName: 'setText',
              args: [node('signedname'), 'simplex.contact', 'smp://mallory'],
            }),
          ],
        },
      ]
      for (const reg of tampered) {
        await commit(controller, reg)
        await expect(
          sponsor.write.registerWithCredit([reg, FAR_FUTURE, sig], {
            account: registrar,
          }),
        ).toBeRevertedWithCustomError('InvalidSignature')
      }
    })

    it('leaves the secret and the duration to the payer', async () => {
      const { controller, sponsor, baseRegistrar } = await load()
      const signed = registration('payername', bob.address)
      const sig = await signRegistration(bobClient, sponsor.address, signed)
      const reg = {
        ...signed,
        secret: keccak256(toHex('chosen later')),
        duration: 3n * MIN_REGISTRATION,
      }
      await commit(controller, reg)
      await sponsor.write.registerWithCredit([reg, FAR_FUTURE, sig], {
        account: registrar,
      })
      expect(
        await baseRegistrar.read.ownerOf([BigInt(labelhash('payername'))]),
      ).toBe(getAddress(bob.address))
    })

    it('refuses an expired signature', async () => {
      const { controller, sponsor } = await load()
      const reg = registration('latename', bob.address)
      await commit(controller, reg)
      await expect(
        sponsor.write.registerWithCredit(
          await withConsent(connection, sponsor, reg, 1n),
          { account: registrar },
        ),
      ).toBeRevertedWithCustomError('SignatureExpired')
    })

    it('only the sponsor reaches the controller sponsored entry points', async () => {
      const { controller } = await load()
      const reg = registration('directname', registrar.address)
      await commit(controller, reg)
      await expect(
        controller.write.registerSponsored([reg], { account: registrar }),
      ).toBeRevertedWithCustomError('NotSponsor')
      await expect(
        controller.write.renewSponsored(
          ['alicename', MIN_REGISTRATION, zeroHash],
          {
            account: registrar,
          },
        ),
      ).toBeRevertedWithCustomError('NotSponsor')
    })

    it('a registrar registering to itself needs no signature', async () => {
      const { controller, sponsor, baseRegistrar } = await load()
      const reg = registration('selfname', registrar.address)
      await commit(controller, reg)
      await sponsor.write.registerWithCredit([reg, 0n, '0x'], {
        account: registrar,
      })
      expect(
        await baseRegistrar.read.ownerOf([BigInt(labelhash('selfname'))]),
      ).toBe(getAddress(registrar.address))
    })

    it('a contract owner consents through ERC-1271', async () => {
      const { controller, sponsor, baseRegistrar } = await load()
      const wallet = await connection.viem.deployContract(
        'MockSmartContractWallet',
        [bob.address],
      )
      const reg = registration('walletname', wallet.address)
      await commit(controller, reg)
      await sponsor.write.registerWithCredit(
        [
          reg,
          FAR_FUTURE,
          await signRegistration(bobClient, sponsor.address, reg),
        ],
        { account: registrar },
      )
      expect(
        await baseRegistrar.read.ownerOf([BigInt(labelhash('walletname'))]),
      ).toBe(getAddress(wallet.address))
    })

    it('a registration with records still hands the name and its node to the owner', async () => {
      const { controller, sponsor, baseRegistrar, ens, resolver } = await load()
      const reg = registration('recordname', bob.address, {
        resolver: resolver.address,
        data: [
          (await import('viem')).encodeFunctionData({
            abi: resolver.abi,
            functionName: 'setText',
            args: [node('recordname'), 'simplex.contact', 'smp://bob'],
          }),
        ],
      })
      await sponsored({ controller, sponsor }, reg)
      expect(
        await baseRegistrar.read.ownerOf([BigInt(labelhash('recordname'))]),
      ).toBe(getAddress(bob.address))
      expect(await ens.read.owner([node('recordname')])).toBe(
        getAddress(bob.address),
      )
      expect(
        await resolver.read.text([node('recordname'), 'simplex.contact']),
      ).toBe('smp://bob')
    })
  })

  describe('transfer', () => {
    it('the holder cannot push a name to anyone, by any entry point', async () => {
      const { baseRegistrar } = await load()
      await expect(
        baseRegistrar.write.transferFrom(
          [alice.address, bob.address, ALICE_ID],
          {
            account: alice,
          },
        ),
      ).toBeRevertedWithCustomError('RecipientMustBeCaller')
      await expect(
        baseRegistrar.write.safeTransferFrom(
          [alice.address, bob.address, ALICE_ID],
          { account: alice },
        ),
      ).toBeRevertedWithCustomError('RecipientMustBeCaller')
      await expect(
        baseRegistrar.write.safeTransferFrom(
          [alice.address, bob.address, ALICE_ID, '0x'],
          { account: alice },
        ),
      ).toBeRevertedWithCustomError('RecipientMustBeCaller')
    })

    it('neither can an approved spender or an operator', async () => {
      const { baseRegistrar } = await load()
      await baseRegistrar.write.approve([bob.address, ALICE_ID], {
        account: alice,
      })
      await expect(
        baseRegistrar.write.transferFrom(
          [alice.address, carol.address, ALICE_ID],
          {
            account: bob,
          },
        ),
      ).toBeRevertedWithCustomError('RecipientMustBeCaller')
      await baseRegistrar.write.setApprovalForAll([carol.address, true], {
        account: alice,
      })
      await expect(
        baseRegistrar.write.transferFrom(
          [alice.address, bob.address, ALICE_ID],
          {
            account: carol,
          },
        ),
      ).toBeRevertedWithCustomError('RecipientMustBeCaller')
    })

    it('the recipient takes an offered name, with either entry point', async () => {
      const { baseRegistrar, ens } = await load()
      await baseRegistrar.write.approve([bob.address, ALICE_ID], {
        account: alice,
      })
      await baseRegistrar.write.transferFrom(
        [alice.address, bob.address, ALICE_ID],
        {
          account: bob,
        },
      )
      expect(await baseRegistrar.read.ownerOf([ALICE_ID])).toBe(
        getAddress(bob.address),
      )
      expect(await ens.read.owner([node('alicename')])).toBe(
        getAddress(bob.address),
      )

      await baseRegistrar.write.approve([carol.address, ALICE_ID], {
        account: bob,
      })
      await baseRegistrar.write.safeTransferFrom(
        [bob.address, carol.address, ALICE_ID],
        { account: carol },
      )
      expect(await baseRegistrar.read.ownerOf([ALICE_ID])).toBe(
        getAddress(carol.address),
      )
    })

    it('nobody takes a name that was not offered to them', async () => {
      const { baseRegistrar } = await load()
      await expect(
        baseRegistrar.write.transferFrom(
          [alice.address, bob.address, ALICE_ID],
          {
            account: bob,
          },
        ),
      ).toBeRevertedWithString('ERC721: caller is not token owner or approved')
    })

    it('an offer dies when the name moves', async () => {
      const { baseRegistrar } = await load()
      await baseRegistrar.write.approve([bob.address, ALICE_ID], {
        account: alice,
      })
      await baseRegistrar.write.setApprovalForAll([carol.address, true], {
        account: alice,
      })
      // carol, an operator, takes it for herself
      await baseRegistrar.write.transferFrom(
        [alice.address, carol.address, ALICE_ID],
        {
          account: carol,
        },
      )
      await expect(
        baseRegistrar.write.transferFrom(
          [carol.address, bob.address, ALICE_ID],
          {
            account: bob,
          },
        ),
      ).toBeRevertedWithString('ERC721: caller is not token owner or approved')
    })

    it('an offer dies when the name is re-registered', async () => {
      const f = await load()
      await f.baseRegistrar.write.approve([bob.address, ALICE_ID], {
        account: alice,
      })
      await connection.networkHelpers.time.increase(
        Number(MIN_REGISTRATION + GRACE + 1n),
      )
      await sponsored(f, registration('alicename', carol.address))
      await expect(
        f.baseRegistrar.write.transferFrom(
          [carol.address, bob.address, ALICE_ID],
          {
            account: bob,
          },
        ),
      ).toBeRevertedWithString('ERC721: caller is not token owner or approved')
    })
  })

  describe('registry', () => {
    it('the holder cannot make anyone else the manager of their name', async () => {
      const { ens } = await load()
      await expect(
        ens.write.setOwner([node('alicename'), bob.address], {
          account: alice,
        }),
      ).toBeRevertedWithCustomError('OwnerMustBeCaller')
      await expect(
        ens.write.setRecord([node('alicename'), bob.address, zeroAddress, 0n], {
          account: alice,
        }),
      ).toBeRevertedWithCustomError('OwnerMustBeCaller')
    })

    it('an operator the holder appointed can take the node for itself', async () => {
      const { ens } = await load()
      await ens.write.setApprovalForAll([bob.address, true], { account: alice })
      await ens.write.setOwner([node('alicename'), bob.address], {
        account: bob,
      })
      expect(await ens.read.owner([node('alicename')])).toBe(
        getAddress(bob.address),
      )
    })

    it('reclaim points the node at the holder only', async () => {
      const { ens, baseRegistrar } = await load()
      await expect(
        baseRegistrar.write.reclaim([ALICE_ID, bob.address], {
          account: alice,
        }),
      ).rejects.toThrow()
      await ens.write.setOwner([node('alicename'), zeroAddress], {
        account: alice,
      })
      await baseRegistrar.write.reclaim([ALICE_ID, alice.address], {
        account: alice,
      })
      expect(await ens.read.owner([node('alicename')])).toBe(
        getAddress(alice.address),
      )
    })

    it('the holder cannot create a subnode owned by anyone else', async () => {
      const { ens } = await load()
      await expect(
        ens.write.setSubnodeOwner(
          [node('alicename'), labelhash('x'), bob.address],
          {
            account: alice,
          },
        ),
      ).toBeRevertedWithCustomError('OwnerMustBeCaller')
      await expect(
        ens.write.setSubnodeRecord(
          [node('alicename'), labelhash('x'), bob.address, zeroAddress, 0n],
          { account: alice },
        ),
      ).toBeRevertedWithCustomError('OwnerMustBeCaller')
      // a subnode of their own is still theirs to make
      await ens.write.setSubnodeOwner(
        [node('alicename'), labelhash('x'), alice.address],
        { account: alice },
      )
    })

    it('the root assigns TLDs and marks them, so their registrars may assign names', async () => {
      const { ens } = await load()
      expect(await ens.read.isTld([TLD_NODE])).toBe(true)
      expect(await ens.read.isTld([node('alicename')])).toBe(false)
      expect(await ens.read.isTld([zeroHash])).toBe(false)
    })
  })
})
