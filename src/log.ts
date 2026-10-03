/** Keep stdout reserved for the MCP stdio transport. */
export function writeStderr(message: string): void {
  process.stderr.write(`${message}\n`);
}
