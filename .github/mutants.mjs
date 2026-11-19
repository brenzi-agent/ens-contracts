import { readFileSync, writeFileSync } from 'node:fs'

const S = 'contracts/simplex/SimplexSettlement.sol'
const P = 'contracts/simplex/SimplexNamePolicy.sol'
const C = 'contracts/simplex/SimplexController.sol'
const N = 'contracts/simplex/SimplexSponsor.sol'

export const mutants = [
  [S, 'if (msg.sender != address(controller)) revert NotController();', ''],
  [S, 'if (address(this) == _self) revert NotProxy();\n        if (reversibleDays', 'if (reversibleDays'],
  [S, 'if (reversibleDays > MAX_REVERSIBLE_DAYS)\n            revert ReversibleDaysTooMany(reversibleDays);', ''],
  [S, 'uint256 start = renewal ? registrar.nameExpires(id) : block.timestamp;', 'uint256 start = block.timestamp;'],
  [S, 'if (firstExpiry < start) firstExpiry = start;', ''],
  [S, 'if (duration <= extension) revert DurationTooShort(duration);', ''],
  [S, 'if (entry.reversed) revert PaymentReversed(label);', ''],
  [S, 'if (block.timestamp < entry.reversibleUntil)\n            revert ReversiblePeriodNotEnded(label);', ''],
  [S, 'msg.sender != controller.beneficiary() &&\n            msg.sender != controller.owner()', 'false'],
  [S, 'msg.sender != controller.beneficiary() &&', 'msg.sender != controller.owner() &&'],
  [S, '!_inEffect(id, entry) ||\n                entry.reversed ||', 'entry.reversed ||'],
  [S, 'entry.reversed ||\n                block.timestamp >= entry.reversibleUntil', 'block.timestamp >= entry.reversibleUntil'],
  [S, '||\n                block.timestamp >= entry.reversibleUntil', ''],
  [S, 'if (msg.sender != controller.owner()) revert NotOwner();\n        for', 'for'],
  [S, '!_inEffect(id, entry) || !entry.reversed', '!entry.reversed'],
  [S, '!_inEffect(id, entry) || !entry.reversed', '!_inEffect(id, entry)'],
  [S, 'if (address(this) == _self) revert NotProxy();\n        Entry memory entry', 'Entry memory entry'],
  [S, 'if (address(this) == _self) revert NotProxy();\n        if (\n            msg.sender != controller.beneficiary()', 'if (\n            msg.sender != controller.beneficiary()'],
  [S, 'if (address(this) == _self) revert NotProxy();\n        if (msg.sender != controller.owner()) revert NotOwner();\n        for', 'if (msg.sender != controller.owner()) revert NotOwner();\n        for'],
  [S, '_inEffect(id, entry) && !(entry.renewal && entry.reversed)', '_inEffect(id, entry)'],
  [S, 'block.timestamp <= entry.firstExpiry + _GRACE_PERIOD &&', ''],
  [S, '&&\n            registrar.nameExpires(id) == entry.firstExpiry', ''],
  [S, 'if (msg.sender != controller.owner()) revert NotOwner();\n        if (controller.frozen())', 'if (controller.frozen())'],
  [S, 'if (controller.frozen()) revert Frozen();', ''],
  [S, 'next.controller() != controller || next.registrar() != registrar', 'next.registrar() != registrar'],
  [S, 'next.controller() != controller || next.registrar() != registrar', 'next.controller() != controller'],
  [P, 'if (reversed) revert PaymentReversed(label);\n        bytes32 accepted = acceptedClaimTerms', 'bytes32 accepted = acceptedClaimTerms'],
  [P, 'if (reversed) revert PaymentReversed(label);\n        if (reversibleUntil != 0)', 'if (reversibleUntil != 0)'],
  [S, 'if (renewal && _inEffect(id, _entries[id]))\n            revert RenewalReversed(bytes32(id));', ''],
  [S, 'renewal && _inEffect(id, _entries[id])', '_inEffect(id, _entries[id])'],
  [S, 'renewal && _inEffect(id, _entries[id])', 'renewal'],
  [P, 'if (reversibleUntil != 0) revert PaymentNotSettled(label);', ''],
  [P, '||\n            next.settlement() != settlement', ''],
  [P, 'bound.controller() != _controller || ', ''],
  [P, ' || bound.registrar() != _registrar', ''],
  [P, '_settlement.reversiblePayment(0);', ''],
  [C, '&&\n            INamePolicy(newNamePolicy).settlement() != INamePolicy(namePolicy).settlement()', '&& false'],
  [C, 'expires + duration - extension > block.timestamp + horizon', 'expires > block.timestamp + horizon'],
  [C, 'expires + duration - extension > block.timestamp + horizon', 'expires + duration > block.timestamp + horizon'],
  [C, 'if (reversibleDays != 0)\n            term =', 'if (true)\n            term ='],
  [C, 'if (reversibleDays != 0)\n            extension =', 'if (true)\n            extension ='],
  [N, 'if (reversibleDays != 0 && holder != msg.sender)\n            _consumeIntent(', 'if (false)\n            _consumeIntent('],
  [N, 'reversibleDays != 0 && holder != msg.sender', 'holder != msg.sender'],
  [N, 'keccak256(abi.encodePacked(dataHashes)),\n                    reversibleDays,', 'keccak256(abi.encodePacked(dataHashes)),\n                    uint256(0),'],
]

const index = Number(process.argv[2])
const [file, from, to] = mutants[index]
const source = readFileSync(file, 'utf8')
if (source.split(from).length !== 2) throw new Error(`mutant ${index}: expected one match in ${file}`)
writeFileSync(file, source.replace(from, to))
console.log(`mutant ${index} in ${file}:\n- ${from}\n+ ${to}`)
