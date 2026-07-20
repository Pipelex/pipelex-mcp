import { createHostedServer } from "./hosted/server.js";

const server = createHostedServer();

export default await server.run();

export type AppType = typeof server;
