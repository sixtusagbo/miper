import { Connection, PublicKey } from '@solana/web3.js';
import { logger } from './logger';

// Metaplex Token Metadata program. Every SPL / Token-2022 mint that ever gets
// a name/symbol/uri does so by writing a PDA owned by this program.
const METAPLEX_METADATA_PROGRAM_ID = new PublicKey(
  'metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s'
);

export interface TokenMetadata {
  name: string;
  symbol: string;
  uri: string;
}

// Derive the metadata PDA the same way the Metaplex program does.
export function metadataPda(mint: PublicKey): PublicKey {
  const [pda] = PublicKey.findProgramAddressSync(
    [
      Buffer.from('metadata'),
      METAPLEX_METADATA_PROGRAM_ID.toBuffer(),
      mint.toBuffer(),
    ],
    METAPLEX_METADATA_PROGRAM_ID
  );
  return pda;
}

// Borsh-serialized strings in the Metaplex metadata account are `u32 LE
// length prefix + bytes`. The program puffs the strings up to their max
// lengths (32 name, 10 symbol, 200 uri) with trailing nulls before writing,
// so the stored length reflects the padded size and we strip the nulls here.
function readPuffedString(buf: Buffer, offset: number): { value: string; next: number } {
  if (offset + 4 > buf.length) throw new Error('metadata truncated at length prefix');
  const length = buf.readUInt32LE(offset);
  const start = offset + 4;
  const end = start + length;
  if (end > buf.length) throw new Error('metadata truncated mid-string');
  const raw = buf.slice(start, end).toString('utf8');
  return { value: raw.replace(/\0+$/, ''), next: end };
}

export function decodeMetadata(data: Buffer): TokenMetadata {
  // Account layout prefix: key (u8) + updateAuthority (32) + mint (32) = 65.
  let offset = 65;
  const name = readPuffedString(data, offset); offset = name.next;
  const symbol = readPuffedString(data, offset); offset = symbol.next;
  const uri = readPuffedString(data, offset); offset = uri.next;
  return { name: name.value, symbol: symbol.value, uri: uri.value };
}

export async function fetchTokenMetadata(
  connection: Connection,
  mint: string
): Promise<TokenMetadata | null> {
  try {
    const pda = metadataPda(new PublicKey(mint));
    const info = await connection.getAccountInfo(pda);
    if (!info?.data) return null;
    return decodeMetadata(Buffer.from(info.data));
  } catch (err) {
    logger.debug(`fetchTokenMetadata ${mint}: ${(err as Error).message}`);
    return null;
  }
}
