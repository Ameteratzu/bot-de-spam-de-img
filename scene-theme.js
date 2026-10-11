export function themeForAutomaticSlot(slot) {
  if (!Number.isInteger(slot) || slot < 0 || slot > 9) throw new RangeError('La franja diaria debe estar entre 0 y 9.');
  return slot % 2 ? 'night' : 'day';
}

export function themeForManualCursor(cursor) {
  if (!Number.isInteger(cursor) || cursor < 0) throw new RangeError('El contador manual debe ser un entero no negativo.');
  return cursor % 2 ? 'night' : 'day';
}
