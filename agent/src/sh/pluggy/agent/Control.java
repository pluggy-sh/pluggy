package sh.pluggy.agent;

import java.io.BufferedReader;
import java.io.IOException;
import java.io.InputStreamReader;
import java.io.OutputStream;
import java.net.Socket;
import java.nio.charset.StandardCharsets;

/**
 * Control-socket client. pluggy opens a loopback listener before spawning the
 * JVM and passes its port + a nonce via {@code -Dpluggy.agent.port/.token}. We
 * connect back, send {@code hello\t<token>\t<pid>}, then reply to each
 * {@code reload} with the {@link Reloader.Result}.
 *
 * A socket avoids the server's logging pipeline, so it behaves identically on
 * every platform. If the connection can't be made or drops, hotswap goes quiet
 * and the server is unaffected.
 */
final class Control implements Runnable {

  private final int port;
  private final String token;

  Control(int port, String token) {
    this.port = port;
    this.token = token;
  }

  @Override
  public void run() {
    // Pin IPv4 loopback to match pluggy's `listen(port, "127.0.0.1")`; on a
    // dual-stack host getLoopbackAddress() can be ::1 and fail to connect.
    try (Socket socket = new Socket("127.0.0.1", port)) {
      socket.setTcpNoDelay(true);
      BufferedReader in =
          new BufferedReader(new InputStreamReader(socket.getInputStream(), StandardCharsets.UTF_8));
      OutputStream out = socket.getOutputStream();

      send(out, "hello\t" + (token == null ? "" : token) + "\t" + Agent.pid());

      String line;
      while ((line = in.readLine()) != null) {
        if (line.equals("reload") || line.startsWith("reload\t")) {
          send(out, Agent.reloadNow().wire());
        }
      }
    } catch (IOException e) {
      // Connection dropped; pluggy falls back when a reload gets no reply.
    }
  }

  private static void send(OutputStream out, String line) throws IOException {
    out.write((line + "\n").getBytes(StandardCharsets.UTF_8));
    out.flush();
  }
}
