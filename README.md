# ide-clangd

Provide C and C++ language intelligence through clangd.

Registers [clangd](https://clangd.llvm.org/) with `ide` for C, C++, Objective-C and Objective-C++.

## Features

- **Code intelligence**: provides completions, documentation and signature help.
- **Diagnostics**: reports compiler and clang-tidy findings with available fixes.
- **Navigation**: finds definitions, references, symbols and call relationships.
- **Refactoring**: renames symbols and applies server code actions.
- **Presentation**: provides semantic tokens and inlay hints.
- **Formatting**: formats documents and selections using the project's clang-format rules.
- **Managed install**: downloads checksum-verified official releases and retains their builtin headers.
- **Project sessions**: starts one server per project root when a matching editor opens.

## Installation

To install `ide-clangd` search for it in the Install pane of the Lumine settings, or run the command `lumine --install lumine-code/ide-clangd`.

Install `ide` and `language-c`; Objective-C files also need `language-objective-c`. Install the frontends you want, such as `autocomplete`, `linter`, `hover`, `hyperclick`, `refactor` and `code-format`. Select an existing clangd executable or install one through `ide:manage-servers`.

## Usage

clangd needs the compiler arguments used by your project. It discovers `compile_commands.json` in the source directory or its ancestors, or in a `build` subdirectory; use Compile Commands Path for a different location. With CMake, configure the project with `-DCMAKE_EXPORT_COMPILE_COMMANDS=ON`. Without a compilation database, Fallback Flags can supply the necessary include paths and language standard. Project `.clangd` and `.clang-format` files continue to apply.

Managed releases are available for x64 Windows, macOS and Linux. On other architectures, install clangd through your platform's package manager and select it in Server Path.

## Services

- `ide`: consumed to register clangd with the editor's language-server client.
- `background-tips.provider`: provided to explain compilation database setup.

## Contributing

Got ideas to make this package better, found a bug, or want to help add new features? Just drop your thoughts on GitHub. Any feedback is welcome!
