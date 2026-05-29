// Derive a short model tag like "O4.8" from the model id / display name,
// plus whether this is an extended (1M) context session.

const FAMILY_LETTER: Record<string, string> = {
  haiku: 'H',
  opus: 'O',
  sonnet: 'S',
};

export interface ModelTag {
  short: string; // e.g. "O4.8"
  is1M: boolean;
}

export function modelTag(
  id: string | undefined,
  displayName: string | undefined,
  contextWindowSize: number | undefined,
): ModelTag {
  const rawId = (id ?? '').toLowerCase();
  const is1M = rawId.includes('[1m]') || (contextWindowSize ?? 0) >= 1_000_000;

  // Family letter.
  let letter = '';
  for (const [name, l] of Object.entries(FAMILY_LETTER)) {
    if (rawId.includes(name) || (displayName ?? '').toLowerCase().includes(name)) {
      letter = l;
      break;
    }
  }
  if (!letter) {
    const dn = (displayName ?? '').trim();
    letter = dn ? dn.charAt(0).toUpperCase() : '?';
  }

  // Version "major.minor" from the id (claude-opus-4-8 -> 4.8), falling back to
  // any "N.N" present in the display name.
  let version = '';
  const idMatch = rawId.match(/-(\d+)-(\d+)/);
  if (idMatch) {
    version = `${idMatch[1]}.${idMatch[2]}`;
  } else {
    const dnMatch = (displayName ?? '').match(/(\d+)\.(\d+)/);
    if (dnMatch) version = `${dnMatch[1]}.${dnMatch[2]}`;
  }

  const short = version ? `${letter}${version}` : letter;
  return { is1M, short };
}
