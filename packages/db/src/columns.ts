import { canonicalNameParts, joinName, maskFolio, phoneticKeys } from "@finsol/shared";

import { blindIndex, encryptField, type FieldKeys } from "./crypto.js";

export interface FolioNameInput {
  first: string;
  middle?: string | null;
  last?: string | null;
}

/** The normalised and phonetic search columns for a holder's name (see canonicalNameParts). */
export function folioSearchColumns(name: FolioNameInput) {
  const { first, middle, last } = canonicalNameParts(name);
  return {
    fullNameNorm: joinName({ first, middle, last }),
    firstNameNorm: first,
    middleNameNorm: middle,
    lastNameNorm: last,
    firstNameKey: phoneticKeys(first),
    middleNameKey: phoneticKeys(middle),
    lastNameKey: phoneticKeys(last),
  };
}

/** Ciphertext, teaser mask and blind index for a folio number. */
export function folioColumns(folioNumber: string, keys: FieldKeys) {
  const clean = folioNumber.trim();
  return {
    folioNumber: encryptField(clean, keys),
    folioNumberMasked: maskFolio(clean),
    folioNumberHash: blindIndex(clean, keys),
  };
}
