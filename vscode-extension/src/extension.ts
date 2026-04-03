/**
 * HybX Development System — VSCode Extension
 * Hybrid RobotiX
 *
 * Wraps the HybX Development System bin commands (start, stop, restart,
 * logs, build, addlib, list, clean, newrepo) and runs them over SSH.
 *
 * Configuration (VSCode settings):
 *   hybxDev.sshHost    — SSH connection string, default: arduino@unoq.local
 *   hybxDev.appsPath   — Apps directory on board, default: ~/Arduino
 *   hybxDev.sshKeyPath — Path to SSH private key (optional)
 *   hybxDev.sshPath    — Full path to ssh binary, default: /usr/bin/ssh
 */

import * as vscode from 'vscode';
import { exec, spawn, ChildProcess } from 'child_process';

let outputChannel: vscode.OutputChannel;
let statusBarItem: vscode.StatusBarItem;
let logsProcess: ChildProcess | null = null;
let currentApp: string | null = null;
let appRunning: boolean = false;

export function activate(context: vscode.ExtensionContext) {
    outputChannel = vscode.window.createOutputChannel('HybX');
    outputChannel.show(true);
    outputChannel.appendLine('HybX Development System ready.');

    statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
    statusBarItem.command = 'hybxDev.start';
    updateStatusBar();
    statusBarItem.show();

    const commands: [string, () => void][] = [
        ['hybxDev.connect',  cmdConnect],
        ['hybxDev.start',    cmdStart],
        ['hybxDev.stop',     cmdStop],
        ['hybxDev.restart',  cmdRestart],
        ['hybxDev.logs',     cmdLogs],
        ['hybxDev.build',    cmdBuild],
        ['hybxDev.addlib',   cmdAddlib],
        ['hybxDev.listApps', cmdListApps],
        ['hybxDev.clean',    cmdClean],
        ['hybxDev.newrepo',  cmdNewrepo],
    ];

    for (const [id, handler] of commands) {
        context.subscriptions.push(vscode.commands.registerCommand(id, handler));
    }

    context.subscriptions.push(statusBarItem);
    context.subscriptions.push(outputChannel);
}

export function deactivate() { stopLogsProcess(); }

function cfg(): vscode.WorkspaceConfiguration {
    return vscode.workspace.getConfiguration('hybxDev');
}
function sshHost(): string { return cfg().get<string>('sshHost', 'arduino@unoq.local'); }
function appsPath(): string { return cfg().get<string>('appsPath', '~/Arduino'); }
function sshKeyPath(): string { return cfg().get<string>('sshKeyPath', ''); }
function sshBinary(): string { return cfg().get<string>('sshPath', '/usr/bin/ssh'); }

function sshArgs(): string[] {
    const args = ['-o', 'StrictHostKeyChecking=no', '-o', 'ConnectTimeout=10'];
    const key = sshKeyPath();
    if (key) { args.push('-i', key); }
    return args;
}

function sshRun(remoteCmd: string, label: string): Promise<void> {
    return new Promise((resolve, reject) => {
        outputChannel.show(true);
        outputChannel.appendLine(`\n─── ${label} ───────────────────────────`);
        const args = [...sshArgs(), sshHost(), remoteCmd];
        const proc = spawn(sshBinary(), args);
        proc.stdout.on('data', (d: Buffer) => outputChannel.append(d.toString()));
        proc.stderr.on('data', (d: Buffer) => outputChannel.append(d.toString()));
        proc.on('close', (code) => {
            if (code === 0) { resolve(); }
            else { const msg = `Command exited with code ${code}`; outputChannel.appendLine(msg); reject(new Error(msg)); }
        });
        proc.on('error', (err) => { outputChannel.appendLine(`SSH error: ${err.message}`); reject(err); });
    });
}

function sshStream(remoteCmd: string, label: string): ChildProcess {
    outputChannel.show(true);
    outputChannel.appendLine(`\n─── ${label} ───────────────────────────`);
    const args = [...sshArgs(), sshHost(), remoteCmd];
    const proc = spawn(sshBinary(), args);
    proc.stdout.on('data', (d: Buffer) => outputChannel.append(d.toString()));
    proc.stderr.on('data', (d: Buffer) => outputChannel.append(d.toString()));
    proc.on('close', (code) => { outputChannel.appendLine(`\n[logs ended, exit ${code}]`); });
    proc.on('error', (err) => { outputChannel.appendLine(`SSH error: ${err.message}`); });
    return proc;
}

function updateStatusBar() {
    if (currentApp && appRunning) {
        statusBarItem.text = `$(play) HybX: ${currentApp}`;
        statusBarItem.tooltip = 'HybX app running — click to start/pick app';
        statusBarItem.backgroundColor = undefined;
    } else if (currentApp && !appRunning) {
        statusBarItem.text = `$(debug-stop) HybX: ${currentApp} (stopped)`;
        statusBarItem.tooltip = 'HybX app stopped — click to start';
        statusBarItem.backgroundColor = new vscode.ThemeColor('statusBarItem.warningBackground');
    } else {
        statusBarItem.text = `$(circuit-board) HybX`;
        statusBarItem.tooltip = 'HybX Development System — click to start an app';
        statusBarItem.backgroundColor = undefined;
    }
}

async function pickApp(): Promise<string | undefined> {
    return new Promise((resolve) => {
        const ssh = sshBinary();
        const args = [...sshArgs(), sshHost(), `ls -1 ${appsPath()} 2>/dev/null`];
        exec(`"${ssh}" ${args.join(' ')}`, (err, stdout) => {
            let items: string[] = [];
            if (!err && stdout.trim()) { items = stdout.trim().split('\n').filter(Boolean); }
            items.push('$(edit) Enter app name manually...');
            vscode.window.showQuickPick(items, { placeHolder: 'Select an app or enter manually', title: 'HybX: Pick App' }).then(async (sel) => {
                if (!sel) { resolve(undefined); return; }
                if (sel.startsWith('$(edit)')) {
                    const manual = await vscode.window.showInputBox({ prompt: 'App name (e.g. matrix-bno)', placeHolder: 'matrix-bno' });
                    resolve(manual);
                } else { resolve(sel); }
            });
        });
    });
}

async function cmdConnect() {
    outputChannel.show(true);
    outputChannel.appendLine(`\n─── connect ────────────────────────────`);
    outputChannel.appendLine(`SSH binary: ${sshBinary()}`);
    outputChannel.appendLine(`Testing connection to ${sshHost()} ...`);
    try {
        await sshRun('echo "HybX connected — $(uname -r)"', 'connect');
        vscode.window.showInformationMessage(`✓ Connected to ${sshHost()}`);
    } catch {
        vscode.window.showErrorMessage(`Cannot connect to ${sshHost()}. Check Settings → hybxDev.sshHost and that the board is on the network.`);
    }
}

async function cmdStart() {
    const app = await pickApp();
    if (!app) { return; }
    stopLogsProcess();
    currentApp = app; appRunning = false; updateStatusBar();
    try {
        await sshRun(`start ${app}`, `start ${app}`);
        appRunning = true; updateStatusBar();
        startLogsStream(app);
    } catch {
        vscode.window.showErrorMessage(`start ${app} failed.`);
        updateStatusBar();
    }
}

async function cmdStop() {
    stopLogsProcess();
    const app = currentApp || await pickApp();
    if (!app) { return; }
    try {
        await sshRun(`stop ${app}`, `stop ${app}`);
        appRunning = false; updateStatusBar();
    } catch { vscode.window.showErrorMessage('stop failed.'); }
}

async function cmdRestart() {
    const app = currentApp || await pickApp();
    if (!app) { return; }
    stopLogsProcess();
    currentApp = app; appRunning = false; updateStatusBar();
    try {
        await sshRun(`restart ${app}`, `restart ${app}`);
        appRunning = true; updateStatusBar();
        startLogsStream(app);
    } catch {
        vscode.window.showErrorMessage(`restart ${app} failed.`);
        updateStatusBar();
    }
}

function cmdLogs() {
    if (!currentApp) { vscode.window.showWarningMessage('No app running. Use HybX: Start App first.'); return; }
    stopLogsProcess();
    startLogsStream(currentApp);
}

async function cmdBuild() {
    const sketch = await vscode.window.showInputBox({
        prompt: 'Sketch path on board (e.g. ~/Arduino/matrix-bno/sketch)',
        placeHolder: '~/Arduino/matrix-bno/sketch',
        value: currentApp ? `${appsPath()}/${currentApp}/sketch` : ''
    });
    if (!sketch) { return; }
    try {
        await sshRun(`build ${sketch}`, `build ${sketch}`);
        vscode.window.showInformationMessage(`✓ Build complete: ${sketch}`);
    } catch { vscode.window.showErrorMessage('Build failed.'); }
}

async function cmdAddlib() {
    const action = await vscode.window.showQuickPick(['search', 'install', 'list', 'upgrade'], { placeHolder: 'addlib action', title: 'HybX: Add Library' });
    if (!action) { return; }
    if (action === 'list' || action === 'upgrade') { await sshRun(`addlib ${action}`, `addlib ${action}`); return; }
    const libName = await vscode.window.showInputBox({ prompt: `Library name to ${action}`, placeHolder: 'Adafruit SCD30' });
    if (!libName) { return; }
    await sshRun(`addlib ${action} "${libName}"`, `addlib ${action} ${libName}`);
}

async function cmdListApps() { await sshRun('list', 'list apps'); }

async function cmdClean() {
    const app = currentApp || await pickApp();
    if (!app) { return; }
    stopLogsProcess();
    const confirm = await vscode.window.showWarningMessage(`Clean will nuke Docker + cache for "${app}" and restart. Continue?`, 'Yes', 'No');
    if (confirm !== 'Yes') { return; }
    try {
        await sshRun(`clean ${app}`, `clean ${app}`);
        appRunning = true; updateStatusBar();
        startLogsStream(app);
    } catch { vscode.window.showErrorMessage('clean failed.'); }
}

async function cmdNewrepo() {
    const confirm = await vscode.window.showWarningMessage('newrepo will wipe ~/Arduino and ~/bin on the board and re-clone from GitHub. Continue?', 'Yes', 'No');
    if (confirm !== 'Yes') { return; }
    stopLogsProcess();
    currentApp = null; appRunning = false; updateStatusBar();
    try {
        await sshRun('newrepo', 'newrepo bootstrap');
        vscode.window.showInformationMessage('✓ newrepo complete — board environment rebuilt.');
    } catch { vscode.window.showErrorMessage('newrepo failed.'); }
}

function startLogsStream(app: string) {
    stopLogsProcess();
    outputChannel.show(true);
    logsProcess = sshStream(`logs ${app}`, `logs ${app}`);
}

function stopLogsProcess() {
    if (logsProcess) { logsProcess.kill(); logsProcess = null; }
}
