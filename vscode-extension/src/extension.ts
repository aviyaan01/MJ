import * as vscode from 'vscode';
import * as http from 'http';

let server: http.Server | undefined;
const PORT = 62453;

export function activate(context: vscode.ExtensionContext) {
    console.log('MJ VS Code Control Extension is now active!');

    startServer();

    let disposable = vscode.commands.registerCommand('mj-vscode-control.restartServer', () => {
        stopServer();
        startServer();
        vscode.window.showInformationMessage('MJ Control Server restarted.');
    });

    context.subscriptions.push(disposable);
}

function startServer() {
    server = http.createServer(async (req, res) => {
        // Simple CORS
        res.setHeader('Access-Control-Allow-Origin', '*');
        res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
        res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

        if (req.method === 'OPTIONS') {
            res.writeHead(200);
            res.end();
            return;
        }

        if (req.url === '/ping' && req.method === 'GET') {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ status: 'ok', message: 'MJ VS Code Control Server running' }));
            return;
        }

        if (req.url === '/execute' && req.method === 'POST') {
            let body = '';
            req.on('data', chunk => {
                body += chunk.toString();
            });
            req.on('end', async () => {
                try {
                    const data = JSON.parse(body);
                    const result = await handleCommand(data);
                    res.writeHead(200, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ success: true, result }));
                } catch (err: any) {
                    res.writeHead(500, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ success: false, error: err.message }));
                }
            });
            return;
        }

        res.writeHead(404);
        res.end();
    });

    server.listen(PORT, '127.0.0.1', () => {
        console.log(`MJ Control Server listening on port ${PORT}`);
    });
    
    server.on('error', (err) => {
        console.error('Failed to start MJ Control Server:', err);
    });
}

function stopServer() {
    if (server) {
        server.close();
        server = undefined;
    }
}

async function handleCommand(data: any): Promise<any> {
    const action = data.action;
    
    if (action === 'goto_line') {
        const fileUri = vscode.Uri.file(data.file);
        const line = data.line ? Math.max(0, parseInt(data.line) - 1) : 0;
        const col = data.column ? Math.max(0, parseInt(data.column) - 1) : 0;
        
        const document = await vscode.workspace.openTextDocument(fileUri);
        const editor = await vscode.window.showTextDocument(document);
        
        const position = new vscode.Position(line, col);
        editor.selection = new vscode.Selection(position, position);
        editor.revealRange(new vscode.Range(position, position), vscode.TextEditorRevealType.InCenter);
        return { message: `Opened ${data.file} at line ${line + 1}` };
    }
    
    else if (action === 'diff') {
        const file1Uri = vscode.Uri.file(data.file1);
        const file2Uri = vscode.Uri.file(data.file2);
        const title = data.title || `${data.file1} ↔ ${data.file2}`;
        
        await vscode.commands.executeCommand('vscode.diff', file1Uri, file2Uri, title);
        return { message: `Opened diff view` };
    }
    
    else if (action === 'run_in_terminal') {
        let terminal = vscode.window.activeTerminal;
        if (!terminal) {
            terminal = vscode.window.createTerminal("MJ Terminal");
        }
        terminal.show();
        terminal.sendText(data.command);
        return { message: `Executed command in terminal` };
    }
    
    else if (action === 'list_open_tabs') {
        const tabs: string[] = [];
        for (const tabGroup of vscode.window.tabGroups.all) {
            for (const tab of tabGroup.tabs) {
                if (tab.input instanceof vscode.TabInputText) {
                    tabs.push(tab.input.uri.fsPath);
                } else if (tab.label) {
                    tabs.push(`[Non-Text] ${tab.label}`);
                }
            }
        }
        return { tabs };
    }
    
    else if (action === 'close_tab') {
        const targetFile = data.file;
        let closedCount = 0;
        for (const tabGroup of vscode.window.tabGroups.all) {
            for (const tab of tabGroup.tabs) {
                if (targetFile) {
                    if (tab.input instanceof vscode.TabInputText && tab.input.uri.fsPath === targetFile) {
                        await vscode.window.tabGroups.close(tab);
                        closedCount++;
                    }
                } else {
                    // close active tab
                    if (tab.isActive) {
                        await vscode.window.tabGroups.close(tab);
                        closedCount++;
                    }
                }
            }
        }
        return { message: `Closed ${closedCount} tab(s)` };
    }
    
    else if (action === 'insert_text') {
        const editor = vscode.window.activeTextEditor;
        if (!editor) {
            throw new Error("No active editor");
        }
        
        let position: vscode.Position;
        if (data.line !== undefined) {
            const line = Math.max(0, parseInt(data.line) - 1);
            const col = data.column ? Math.max(0, parseInt(data.column) - 1) : 0;
            position = new vscode.Position(line, col);
        } else {
            position = editor.selection.active;
        }
        
        await editor.edit(editBuilder => {
            editBuilder.insert(position, data.text);
        });
        
        return { message: `Text inserted` };
    }
    
    throw new Error(`Unknown action: ${action}`);
}

export function deactivate() {
    stopServer();
}
