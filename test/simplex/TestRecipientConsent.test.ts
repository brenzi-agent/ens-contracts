import hre from 'hardhat'
import {
  encodeFunctionData,
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
  acceptGeneralTermsForClaim,
  AMPLE_ALLOWANCE,
  commitUnderGeneralTerms,
  deployNamesV2,
  FAR_FUTURE,
  MIN_REGISTRATION,
  node,
  registerWithCredit,
  registration,
  signGeneralTermsAcceptance,
  signRegistration,
  sponsorOf,
  TLD_NODE,
} from './fixtures/namesV2.js'

const connection = await hre.network.connect()
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
  await sponsoredRegister(
    f.controller,
    registration('alicename', alice.address),
  )
  return f
}
const load = () => connection.networkHelpers.loadFixture(fixture)

async function commit(controller: any, reg: any) {
  await commitUnderGeneralTerms(connection, controller, reg, {
    account: reg.owner,
  })
}

async function sponsoredRegister(controller: any, reg: any) {
  await commit(controller, reg)
  const sponsor = await sponsorOf(connection, controller)
  return registerWithCredit(connection, sponsor, reg, { account: registrar })
}

/**
 * Nobody becomes the holder of a name, or the owner of a registry node, without
 * their consent: being the caller, or signing.
 */
describe('recipient consent', () => {
  describe('registration', () => {
    it('pins the EIP-712 type hash', async () => {
      const { sponsor } = await load()
      expect(await sponsor.read.REGISTER_TYPEHASH()).toBe(
        keccak256(
          toHex(
            'RegisterName(string label,address owner,uint256 duration,address resolver,bytes[] data,uint256 nonce,uint256 deadline)',
          ),
        ),
      )
    })

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
      await commit(controller, forAlice)
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
        sponsor.write.registerWithCredit([reg, 0n, FAR_FUTURE, '0x'], {
          account: registrar,
        }),
      ).toBeRevertedWithCustomError('InvalidSignature')
      await expect(
        sponsor.write.registerWithCredit(
          await signRegistration(connection, sponsor, reg, {
            signer: registrarClient,
          }),
          { account: registrar },
        ),
      ).toBeRevertedWithCustomError('InvalidSignature')
    })

    it('a signature covers the label and everything written at registration', async () => {
      const { controller, sponsor, resolver, baseRegistrar } = await load()
      const signed = registration('signedname', bob.address, {
        resolver: resolver.address,
      })
      const [, nonce, deadline, sig] = await signRegistration(
        connection,
        sponsor,
        signed,
      )
      const tampered = [
        { ...signed, label: 'othername' },
        { ...signed, duration: 3n * MIN_REGISTRATION },
        { ...signed, resolver: carol.address },
        {
          ...signed,
          data: [
            encodeFunctionData({
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
          sponsor.write.registerWithCredit([reg, nonce, deadline, sig], {
            account: registrar,
          }),
        ).toBeRevertedWithCustomError('InvalidSignature')
      }
      await commit(controller, signed)
      await sponsor.write.registerWithCredit([signed, nonce, deadline, sig], {
        account: registrar,
      })
      expect(
        await baseRegistrar.read.ownerOf([BigInt(labelhash('signedname'))]),
      ).toBe(getAddress(bob.address))
    })

    it('leaves the secret to the payer', async () => {
      const { controller, sponsor, baseRegistrar } = await load()
      const [signed, nonce, deadline, sig] = await signRegistration(
        connection,
        sponsor,
        registration('payername', bob.address),
      )
      const reg = {
        ...signed,
        secret: keccak256(toHex('chosen later')),
      }
      await commit(controller, reg)
      await sponsor.write.registerWithCredit([reg, nonce, deadline, sig], {
        account: registrar,
      })
      expect(
        await baseRegistrar.read.ownerOf([BigInt(labelhash('payername'))]),
      ).toBe(getAddress(bob.address))
    })

    it('a signature registers a name once, even after the name lapses', async () => {
      const { controller, sponsor } = await load()
      const args = await signRegistration(
        connection,
        sponsor,
        registration('oncename', bob.address),
      )
      await commit(controller, args[0])
      await sponsor.write.registerWithCredit(args, { account: registrar })

      await connection.networkHelpers.time.increase(
        Number(MIN_REGISTRATION + GRACE + 1n),
      )
      await commit(controller, args[0])
      await expect(
        sponsor.write.registerWithCredit(args, { account: registrar }),
      ).toBeRevertedWithCustomError('InvalidNonce')
    })

    it('refuses an expired signature', async () => {
      const { controller, sponsor } = await load()
      const reg = registration('latename', bob.address)
      await commit(controller, reg)
      await expect(
        sponsor.write.registerWithCredit(
          await signRegistration(connection, sponsor, reg, { deadline: 1n }),
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
          { account: registrar },
        ),
      ).toBeRevertedWithCustomError('NotSponsor')
    })

    it('a registrar registering to itself needs no signature', async () => {
      const { controller, sponsor, baseRegistrar } = await load()
      const reg = registration('selfname', registrar.address)
      await commit(controller, reg)
      await sponsor.write.registerWithCredit([reg, 0n, 0n, '0x'], {
        account: registrar,
      })
      expect(
        await baseRegistrar.read.ownerOf([BigInt(labelhash('selfname'))]),
      ).toBe(getAddress(registrar.address))
    })

    it('a contract owner consents through ERC-1271', async () => {
      const { controller, sponsor, baseRegistrar, namePolicy } = await load()
      const wallet = await connection.viem.deployContract(
        'MockSmartContractWallet',
        [bob.address],
      )
      const reg = registration('walletname', wallet.address)
      await namePolicy.write.commitUnderGeneralTermsWithSig(
        await signGeneralTermsAcceptance(connection, controller, reg, {
          signer: bobClient,
        }),
        { account: registrar },
      )
      await sponsor.write.registerWithCredit(
        await signRegistration(connection, sponsor, reg, { signer: bobClient }),
        { account: registrar },
      )
      expect(
        await baseRegistrar.read.ownerOf([BigInt(labelhash('walletname'))]),
      ).toBe(getAddress(wallet.address))
    })

    it('a registration with records still gives the owner the name and its node', async () => {
      const { controller, baseRegistrar, ens, resolver } = await load()
      const reg = registration('recordname', bob.address, {
        resolver: resolver.address,
        data: [
          encodeFunctionData({
            abi: resolver.abi,
            functionName: 'setText',
            args: [node('recordname'), 'simplex.contact', 'smp://bob'],
          }),
        ],
      })
      await sponsoredRegister(controller, reg)
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
          { account: alice },
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
          { account: bob },
        ),
      ).toBeRevertedWithCustomError('RecipientMustBeCaller')
      await baseRegistrar.write.setApprovalForAll([carol.address, true], {
        account: alice,
      })
      await expect(
        baseRegistrar.write.transferFrom(
          [alice.address, bob.address, ALICE_ID],
          { account: carol },
        ),
      ).toBeRevertedWithCustomError('RecipientMustBeCaller')
    })

    it('the recipient takes an offered name, with either entry point', async () => {
      const { baseRegistrar, ens } = await load()
      await baseRegistrar.write.approve([bob.address, ALICE_ID], {
        account: alice,
      })
      await acceptGeneralTermsForClaim(
        connection,
        baseRegistrar,
        ALICE_ID,
        alice.address,
        {
          account: bob,
        },
      )
      await baseRegistrar.write.transferFrom(
        [alice.address, bob.address, ALICE_ID],
        { account: bob },
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
      await acceptGeneralTermsForClaim(
        connection,
        baseRegistrar,
        ALICE_ID,
        bob.address,
        {
          account: carol,
        },
      )
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
          { account: bob },
        ),
      ).toBeRevertedWithString('ERC721: caller is not token owner or approved')
    })

    it('an offer is cleared when the name moves', async () => {
      const { baseRegistrar } = await load()
      await baseRegistrar.write.approve([bob.address, ALICE_ID], {
        account: alice,
      })
      await baseRegistrar.write.setApprovalForAll([carol.address, true], {
        account: alice,
      })
      // carol, an operator, takes it for herself
      await acceptGeneralTermsForClaim(
        connection,
        baseRegistrar,
        ALICE_ID,
        alice.address,
        {
          account: carol,
        },
      )
      await baseRegistrar.write.transferFrom(
        [alice.address, carol.address, ALICE_ID],
        { account: carol },
      )
      await expect(
        baseRegistrar.write.transferFrom(
          [carol.address, bob.address, ALICE_ID],
          { account: bob },
        ),
      ).toBeRevertedWithString('ERC721: caller is not token owner or approved')
    })

    it('an offer is cleared when the name is re-registered', async () => {
      const { controller, baseRegistrar } = await load()
      await baseRegistrar.write.approve([bob.address, ALICE_ID], {
        account: alice,
      })
      await connection.networkHelpers.time.increase(
        Number(MIN_REGISTRATION + GRACE + 1n),
      )
      await sponsoredRegister(
        controller,
        registration('alicename', carol.address),
      )
      await expect(
        baseRegistrar.write.transferFrom(
          [carol.address, bob.address, ALICE_ID],
          { account: bob },
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
      ).toBeRevertedWithoutReason()
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
          { account: alice },
        ),
      ).toBeRevertedWithCustomError('OwnerMustBeCaller')
      await expect(
        ens.write.setSubnodeRecord(
          [node('alicename'), labelhash('x'), bob.address, zeroAddress, 0n],
          { account: alice },
        ),
      ).toBeRevertedWithCustomError('OwnerMustBeCaller')
      // a subnode of their own is still theirs to make, and to clear
      await ens.write.setSubnodeOwner(
        [node('alicename'), labelhash('x'), alice.address],
        { account: alice },
      )
      await ens.write.setSubnodeOwner(
        [node('alicename'), labelhash('x'), zeroAddress],
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
