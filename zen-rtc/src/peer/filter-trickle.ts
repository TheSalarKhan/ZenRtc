// HACK: Filter trickle lines when trickle is disabled #354
export function filterTrickle(sdp: string) {
  return sdp.replace(/a=ice-options:trickle\s\n/g, '');
}
