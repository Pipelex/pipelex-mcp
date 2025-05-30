<div align="center">
<a href="https://www.pipelex.com/"><img src="https://raw.githubusercontent.com/Pipelex/pipelex/main/.github/assets/logo.png" alt="Pipelex Logo" width="400" style="max-width: 100%; height: auto;"></a>

  <h3 align="center">The Model Context Protocol server for Pipelex</h3>
  <p align="center">MCP is a protocol that enables AI Agents to run Pipelex pipelines<br/>as native tools in their toolset.</p>

  <div>
    <a href="https://github.com/Pipelex/pipelex/blob/main/doc/Documentation.md"><strong>Documentation</strong></a> -
    <a href="https://github.com/Pipelex/pipelex-mcp/issues"><strong>Report Bug</strong></a> -
    <a href="https://github.com/Pipelex/pipelex-mcp/discussions"><strong>Feature Request</strong></a>
  </div>
  <br/>

  <p align="center">
    <a href="LICENSE"><img src="https://img.shields.io/badge/License-MIT-blue.svg" alt="MIT License"></a>
    <a href="https://pipelex.com"><img src="https://img.shields.io/badge/Web-pipelex.com-03bb95?logo=google-chrome&logoColor=white&style=flat" alt="Website"></a>
    <br/>
    <br/>
  </p>
</div>

# 📑 Table of Contents

- [Introduction](#introduction)
- [Quick Start](#-quick-start)
  - [Prerequisites](#prerequisites)
  - [Installation](#installation)
- [Adding New Tools](#-adding-new-tools)
- [Known Limitations](#-known-limitations)
- [Contributing](#-contributing)
- [Support](#-support)
- [License](#-license)

# Introduction

> 👉 Check out our [main repository](https://github.com/Pipelex/pipelex) to learn more about Pipelex!

The Model Context Protocol (MCP) is a specialized component of the Pipelex ecosystem that enables AI Agents to interact with Pipelex pipelines as native tools. This protocol bridges the gap between AI agents and the structured, reliable pipeline execution that Pipelex provides.

MCP allows AI agents to:
- Discover available pipelines
- Execute pipelines with specific inputs
- Receive structured outputs in a format they can understand and use

To learn more about MCP itself, check out the [official MCP documentation](https://docs.anthropic.com/en/docs/agents-and-tools/mcp) from Anthropic.

# 🚀 Quick Start

## Prerequisites

- Python >=3.11,<3.12
- [uv](https://github.com/astral-sh/uv) package manager

## Installation

1. Clone the repository:
```bash
git clone https://github.com/Pipelex/pipelex-mcp.git
cd pipelex-mcp
```

2. Install dependencies:
```bash
make install
```

3. Set up your environment:
```bash
cp pipelex_mcp/.env.example pipelex_mcp/.env
# Edit pipelex_mcp/.env with your configuration
```

4. Add your API keys:
Configure your API keys in the `.env` file. These will be used by the MCP server to authenticate with various services.

# MCP Clients

### Cursor
Cursor comes with built-in MCP support. Simply describe the tool you want to use in the chat, and Cursor will automatically invoke it.

[Learn more about MCP in Cursor](https://docs.cursor.com/context/model-context-protocol)

### Claude Desktop
Claude Desktop uses its own configuration format. Check the MCP documentation for setup details:

[Claude Desktop MCP Setup Guide](https://modelcontextprotocol.io/quickstart/server)

### Other Clients
MCP is an open protocol - any client that implements the protocol can interact with MCP servers. Check the MCP documentation for a full list of available clients.

# 🛠 Adding New Tools

Adding a new tool (pipe) to the MCP server is straightforward. Here's a basic example:

```python
@mcp.tool("generate_company_mascott")
async def generate_company_mascott(company_context: str) -> dict:
    """Generate multiple mascot options for a company using the complete design process.
    Output the links of the images.
    
    Args:
        company_context: Context about the company
        
    Returns:
        dict: Response containing generated mascot images
    """
    # Your implementation here
    return {"images": [...]}
```

Key points when adding a new tool:
1. Use the `@mcp.tool` decorator with a unique name
2. Define clear input parameters with type hints
3. Write a comprehensive docstring explaining the tool's purpose
4. Return structured data that the AI agent can understand

For more complex examples and to understand the underlying Pipelex technology, check out the [Pipelex Documentation](https://github.com/Pipelex/pipelex/blob/main/doc/Documentation.md).

# ⚠️ Known Limitations

We are actively working on improving these aspects of the repository:

## Library Duplication
Currently, the `pipelex_libraries` folder needs to exist in two locations:
- At the root of the project
- Inside the `pipelex_mcp` folder

This duplication is not ideal and we're working on a better solution for managing shared libraries.

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

## 🤝 Contributing

We welcome contributions! Please check our issues page or submit a pull request.

## 💬 Support

- **GitHub Issues**: For bug reports and feature requests
- **Discussions**: For questions and community discussions
- [**Documentation**](https://github.com/Pipelex/pipelex/blob/main/doc/Documentation.md)

## 📝 License

This project is licensed under the [MIT license](LICENSE).

---

"Pipelex" is a trademark of Evotis S.A.S.

© 2025 Evotis S.A.S.
