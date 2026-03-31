/** Shared constants used by Vite, the API server, and the CLI entry point. */
import os from "os";
import path from "path";

export var DEFAULT_API_PORT = 4242;

/** Path to the file where the running AgentViz server writes its port. */
export var PORT_FILE = path.join(os.homedir(), ".agentviz", "port");
