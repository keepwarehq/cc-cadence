import * as vscode from 'vscode';
import { ChatController } from './chat';
import { runDoctor } from './doctor';

export function activate(ctx: vscode.ExtensionContext): void {
  const chat = new ChatController(ctx);
  ctx.subscriptions.push(
    chat,
    vscode.window.registerWebviewViewProvider('ccprofile.chat', chat, { webviewOptions: { retainContextWhenHidden: true } }),
    vscode.commands.registerCommand('ccprofile.newChat', () => chat.newChat()),
    vscode.commands.registerCommand('ccprofile.stop', () => chat.stop()),
    vscode.commands.registerCommand('ccprofile.switchProfile', () => chat.pickProfile()),
    vscode.commands.registerCommand('ccprofile.addProfile', () => chat.addProfile()),
    vscode.commands.registerCommand('ccprofile.manageProfiles', () => chat.manageProfiles()),
    vscode.commands.registerCommand('ccprofile.doctor', () => runDoctor(ctx.secrets)),
    vscode.commands.registerCommand('ccprofile.history', () => chat.history()),
  );
}

export function deactivate(): void {}
