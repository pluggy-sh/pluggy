export interface ResolvedDebug {
  enabled: boolean;
  port: number;
  suspend: boolean;
  /**
   * Bind JDWP to all interfaces (`*`) instead of loopback. JDWP is
   * unauthenticated, so all-interfaces exposes RCE to anything on the network;
   * only opt in when the debugger lives on another host (a container or WSL2).
   */
  exposed: boolean;
}

/** The port IDEs default their JDWP attach to. */
export const DEFAULT_DEBUG_PORT = 5005;

/**
 * Build the `-agentlib:jdwp=…` flag. Binds `127.0.0.1` by default: JDWP has no
 * authentication, so binding all interfaces would let any host on the LAN
 * execute code in the server JVM. A local IDE attaches over loopback anyway;
 * `exposed` opts into `*` for the container/WSL2 case where the debugger is on
 * another host.
 */
export function jdwpArg(debug: { port: number; suspend: boolean; exposed?: boolean }): string {
  const suspend = debug.suspend ? "y" : "n";
  const address = `${debug.exposed === true ? "*" : "127.0.0.1"}:${debug.port}`;
  return `-agentlib:jdwp=transport=dt_socket,server=y,suspend=${suspend},address=${address}`;
}
