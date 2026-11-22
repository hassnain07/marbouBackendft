// Stub content classifier — always allows in Slice 2.
// Replace with a real ML call in a later slice.
export async function classifyImage(_buf: Buffer, _purpose: string): Promise<{ allowed: boolean; reason?: string }> {
  return { allowed: true };
}
