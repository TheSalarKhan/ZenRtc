// HACK: Filter trickle lines when trickle is disabled #354
export function removeTrickle(sdp: string) {
  return sdp.replace(/a=ice-options:trickle\s*\r?\n/g, '');
}
