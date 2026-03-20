import { generateMnemonic, mnemonicToSeedSync, validateMnemonic } from 'bip39'
import crypto from 'hypercore-crypto'

export function generateRoom () {
  return generateMnemonic(128) // 12 words, 128 bits entropy
}

export function validateRoom (mnemonic) {
  return validateMnemonic(mnemonic)
}

export function deriveTopicFromMnemonic (mnemonic) {
  const seed = mnemonicToSeedSync(mnemonic)
  return crypto.discoveryKey(seed.slice(0, 32))
}
