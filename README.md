<div align="center">
  <a href="https://www.pipelex.com/"><img src="https://raw.githubusercontent.com/Pipelex/pipelex/main/.github/assets/logo.png" alt="Pipelex Logo" width="400" style="max-width: 100%; height: auto;"></a>

  <h2 align="center">Pipelex MCP Server</h2>

Enable AI agents to build and execute Pipelex pipelines on-the-fly. Just describe what you need, and watch as the agent constructs and runs the pipeline for you.

  <div>
    <a href="https://docs.pipelex.com/"><strong>Documentation</strong></a> -
    <a href="https://github.com/Pipelex/pipelex"><strong>Pipelex Core</strong></a> -
    <a href="https://github.com/Pipelex/pipelex-mcp/issues"><strong>Report Bug</strong></a> -
    <a href="https://go.pipelex.com/discord"><strong>Discord</strong></a>
  </div>
  <br/>

  <p align="center">
    <a href="LICENSE"><img src="https://img.shields.io/badge/License-MIT-blue.svg" alt="MIT License"></a>
    <a href="https://go.pipelex.com/discord"><img src="https://img.shields.io/badge/Discord-5865F2?logo=discord&logoColor=white" alt="Discord"></a>
    <a href="https://docs.pipelex.com/"><img src="https://img.shields.io/badge/Docs-03bb95?logo=read-the-docs&logoColor=white&style=flat" alt="Documentation"></a>
  </p>
</div>

---

# 📑 Table of Contents

- [Introduction](#introduction)
- [Key Features](#-key-features)
- [Quick Start](#-quick-start)
  - [Prerequisites](#prerequisites)
  - [Installation](#installation)
  - [API Key Configuration](#api-key-configuration)
- [Client Setup](#-client-setup)
  - [Cursor](#cursor)
  - [Claude Desktop](#claude-desktop)
  - [Other Clients](#other-clients)
- [Examples](#-examples)
- [Known Limitations](#️-known-limitations)
- [Contributing](#-contributing)
- [Support](#-support)
- [License](#-license)

# Introduction

> 👉 New to Pipelex? Check out the [main repository](https://github.com/Pipelex/pipelex) to learn more!

The **Pipelex MCP Server** implements the [Model Context Protocol](https://modelcontextprotocol.io/) to enable AI agents to interact with [Pipelex](https://github.com/Pipelex/pipelex) as a native tool. This bridges the gap between conversational AI and structured, repeatable AI workflows.

With this MCP server, AI agents can:
- **Build pipelines from natural language descriptions**
- **Execute pipelines with specific inputs**
- **Receive structured outputs** ready for downstream tasks

To learn more about MCP, check out the [official MCP documentation](https://modelcontextprotocol.io/) from Anthropic.

# 🌟 Key Features

**🎯 Natural Language Pipeline Creation**

Simply tell your AI agent what you need:

> "Build me a pipeline that extracts the buyer's name from a purchase receipt, then validates the email format."

The agent will construct the pipeline definition and execute it with your inputs—all in one conversation.

**🔧 Two Powerful Tools**

1. **`pipe_builder`**: Constructs pipeline definitions from natural language
2. **`pipe_runner`**: Executes pipelines with structured inputs

**🚀 Works with Any MCP Client**

- Cursor
- Claude Desktop
- Any MCP-compatible client (not tested yet)

# 🚀 Quick Start

## Prerequisites

- **Python** >=3.11,<3.12
- **[uv](https://github.com/astral-sh/uv)** package manager (**required**)

> **⚠️ Important:** The Pipelex MCP Server requires `uv` to be installed on your system. Make sure to install it before proceeding.

### Installing uv

If you don't have `uv` installed:

```bash
# macOS/Linux
curl -LsSf https://astral.sh/uv/install.sh | sh

# Windows
powershell -c "irm https://astral.sh/uv/install.ps1 | iex"

# Verify installation
uv --version
```

After installation, get the full path to `uv` (you'll need this for MCP configuration):

```bash
which uv
```

Keep this path handy—you'll use it in your MCP client configuration.

## Installation

1. **Clone the repository:**

```bash
git clone https://github.com/Pipelex/pipelex-mcp.git
cd pipelex-mcp
```

2. **Install dependencies:**

```bash
make install
```

## API Key Configuration

### Get Your Pipelex Inference API Key

The MCP server requires a **Pipelex Inference API key** to execute pipelines.

**Get a free API key ($20 in free credits):**

1. Join our [Discord community](https://go.pipelex.com/discord)
2. Request your API key in the [🔑・free-api-key](https://discord.com/channels/1369447918955921449/1418228010431025233) channel

### Set Up Environment Variables

```bash
# Copy the example environment file
cp server/.env.example server/.env

# Edit server/.env and add your API key
# PIPELEX_INFERENCE_API_KEY=your-api-key-here
```

> **Note:** For advanced configuration (bring your own API keys, custom backends), see the [Pipelex API Key Configuration](https://github.com/Pipelex/pipelex#api-key-configuration) guide.

# 🔌 Client Setup

## Cursor

Cursor has **built-in MCP support**. The configuration file is located at `.cursor/mcp.json` in your workspace.

### Configuration

Edit `.cursor/mcp.json` (create it if it doesn't exist):

```json
{
  "mcpServers": {
    "pipelex": {
      "command": "uv",
      "args": [
        "--directory",
        "/absolute/path/to/pipelex-mcp",
        "run",
        "python",
        "-m",
        "server.main"
      ]
    }
  }
}
```

**Important:**
- Replace `/absolute/path/to/pipelex-mcp` with the full path to your cloned repository
- Make sure `uv` is in your system PATH (verify with `which uv`)

**Example:**

```json
{
  "mcpServers": {
    "pipelex": {
      "command": "uv",
      "args": [
        "--directory",
        "../pipelex-mcp",
        "run",
        "python",
        "-m",
        "server.main"
      ]
    }
  }
}
```

### Usage

After configuration, simply chat with Cursor:

> "Build me a pipeline to extract email addresses from text and validate them."

Cursor will automatically invoke the Pipelex MCP tools to build and execute the pipeline.

[Learn more about MCP in Cursor](https://docs.cursor.com/context/model-context-protocol)

## Claude Desktop

Claude Desktop also supports MCP through its configuration file.

### Configuration

1. **Open Claude Desktop Settings:**
   - Click **Claude** in the menu bar → **Settings…**
   - Navigate to **Developer** tab
   - Click **Edit Config**

2. **Edit the configuration file:**

**macOS:** `~/Library/Application Support/Claude/claude_desktop_config.json`

**Windows:** `%APPDATA%\Claude\claude_desktop_config.json`

```json
{
  "mcpServers": {
    "pipelex": {
      "command": "uv",
      "args": [
        "--directory",
        "/absolute/path/to/pipelex-mcp",
        "run",
        "python",
        "-m",
        "server.main"
      ]
    }
  }
}
```

**Important:**
- Replace `/absolute/path/to/pipelex-mcp` with the full path to your cloned repository
- Make sure `uv` is in your system PATH (verify with `which uv`)

**Example:**

```json
{
  "mcpServers": {
    "pipelex": {
      "command": "uv",
      "args": [
        "--directory",
        "/Users/yourname/projects/pipelex-mcp",
        "run",
        "python",
        "-m",
        "server.main"
      ]
    }
  }
}
```

3. **Restart Claude Desktop** completely


For more detailed setup instructions, see the [official MCP documentation](https://modelcontextprotocol.io/docs/develop/connect-local-servers).

## Other Clients

MCP is an open protocol. Any client that implements MCP can use this server. Check the [MCP documentation](https://modelcontextprotocol.io/) for a full list of compatible clients.

# 💡 Examples

## Example 1: CV-Job Matching & Interview Question Generation

**Use Case:** Automatically analyze how well a candidate's CV matches a job offer and generate relevant interview questions.

### What it does:

1. Extracts text from a CV PDF
2. Analyzes alignment between CV and job requirements
3. Generates targeted interview questions based on gaps and strengths
4. Compiles everything into a comprehensive interview preparation document

### How to use it:

Simply tell your AI agent:

> "Build me a pipeline that takes a CV PDF and a job offer text, then generates interview questions based on the candidate's alignment with the role."

Then provide:

```
Inputs:
- CV PDF: https://example.com/sample-cv.pdf
- Job Offer Text: "GenAI Engineer at Pipelex (Paris)
  
  We're growing our team of AI engineers in Paris to build our Agentic Knowledge Framework.
  
  Key requirements:
  - Strong Python skills
  - Experience with LLMs and AI frameworks
  - Ability to ship fast and iterate
  - Knowledge of software architecture
  - Passion for building developer tools
  
  ..."
```

The agent will:
1. Use `pipe_builder` to construct the pipeline definition
2. Use `pipe_runner` to execute it with your inputs
3. Return structured interview questions and analysis

# ⚠️ Known Limitations

We are actively working on improving these aspects:

## Instability

It is not stable yet. The inputs are not always correctly parsed.

## UV Package Manager Dependency

Currently, the MCP server requires `uv` to be installed and configured. While you can modify the configuration to use alternative Python package managers, the default setup relies on `uv`. We're working on providing more flexible installation options in future releases.

## Logging Configuration

The current logging system has some limitations:
- Difficulty in redirecting logs to specific files
- Limited control over log formatting and destinations
- No built-in log rotation or management

We're planning to implement a more robust logging system in future updates.

## Long-Running Pipelines

For pipelines that take longer than the MCP client timeout to complete, we need to implement a session ID system. This would allow:
- Handling of timeouts gracefully
- Resuming pipeline execution
- Status tracking for long-running operations

This feature is planned for future releases to better support extended pipeline operations.

# 🤝 Contributing

We welcome contributions! Please check our [issues page](https://github.com/Pipelex/pipelex-mcp/issues) or submit a pull request.

# 💬 Support

- 💬 **[Discord Community](https://go.pipelex.com/discord)** - Get help and share your workflows
- 🐛 **[GitHub Issues](https://github.com/Pipelex/pipelex-mcp/issues)** - Bug reports and feature requests
- 📚 **[Pipelex Documentation](https://docs.pipelex.com/)** - Complete guides and references
- 🌐 **[Pipelex Homepage](https://www.pipelex.com)** - Learn more about Pipelex

# 📝 License

This project is licensed under the [MIT license](LICENSE).

---

"Pipelex" is a trademark of Evotis S.A.S.

© 2025 Evotis S.A.S.
