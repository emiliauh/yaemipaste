use std::io::{self, IsTerminal};
use std::time::Duration;

use crossterm::event::{self, Event, KeyCode};
use crossterm::execute;
use crossterm::terminal::{disable_raw_mode, enable_raw_mode, EnterAlternateScreen, LeaveAlternateScreen};
use ratatui::backend::CrosstermBackend;
use ratatui::layout::{Constraint, Direction, Layout};
use ratatui::style::{Color, Modifier, Style};
use ratatui::text::{Line, Span};
use ratatui::widgets::{Block, Borders, List, ListItem, ListState, Paragraph, Wrap};
use ratatui::Terminal;

#[derive(Clone, Copy)]
struct Action {
    key: &'static str,
    label: &'static str,
    help: &'static str,
}

const ACTIONS: &[Action] = &[
    Action { key: "install", label: "Install / update full stack", help: "Sync source, configure .env, start containers, and initialize admin claim if needed." },
    Action { key: "admin-claim", label: "Generate admin claim token", help: "Create a one-time first-admin claim token without resetting existing admin state." },
    Action { key: "reset-admin-claim", label: "Reset admin claim token", help: "Owner-controlled reset for a lost or expired unclaimed token." },
    Action { key: "init-user", label: "Create initial user", help: "Create a bootstrap user through the configured auth endpoint." },
    Action { key: "create-token", label: "Create auth token", help: "Generate a registration or upload/auth token through the admin endpoint." },
    Action { key: "revoke-token", label: "Revoke token", help: "Revoke an existing token through the admin endpoint." },
    Action { key: "start", label: "Start services", help: "Start the Docker Compose stack." },
    Action { key: "stop", label: "Stop services", help: "Stop the Docker Compose stack without deleting data." },
    Action { key: "restart", label: "Restart services", help: "Restart all stack services." },
    Action { key: "status", label: "Service status", help: "Show Docker Compose service status." },
    Action { key: "uninstall", label: "Uninstall / cleanup", help: "Stop services and optionally remove volumes or files after explicit confirmation." },
];

struct TerminalGuard;

impl Drop for TerminalGuard {
    fn drop(&mut self) {
        let _ = disable_raw_mode();
        let _ = execute!(io::stderr(), LeaveAlternateScreen);
    }
}

fn main() -> io::Result<()> {
    if !io::stderr().is_terminal() {
        println!("menu");
        return Ok(());
    }

    enable_raw_mode()?;
    execute!(io::stderr(), EnterAlternateScreen)?;
    let _guard = TerminalGuard;

    let backend = CrosstermBackend::new(io::stderr());
    let mut terminal = Terminal::new(backend)?;
    let mut selected = 0usize;

    loop {
        terminal.draw(|frame| {
            let area = frame.area();
            let chunks = Layout::default()
                .direction(Direction::Vertical)
                .constraints([
                    Constraint::Length(5),
                    Constraint::Min(12),
                    Constraint::Length(5),
                ])
                .split(area);

            let title = Paragraph::new(vec![
                Line::from(Span::styled("yaemipaste installer", Style::default().fg(Color::Magenta).add_modifier(Modifier::BOLD))),
                Line::from("Choose a safe installer action. Enter runs it through install.sh."),
                Line::from("Use Up/Down, j/k, Enter, or q."),
            ])
            .block(Block::default().borders(Borders::ALL).title("Control Center"))
            .wrap(Wrap { trim: true });
            frame.render_widget(title, chunks[0]);

            let items: Vec<ListItem> = ACTIONS
                .iter()
                .map(|action| ListItem::new(Line::from(vec![
                    Span::styled(action.label, Style::default().fg(Color::White)),
                    Span::raw("  "),
                    Span::styled(action.key, Style::default().fg(Color::DarkGray)),
                ])))
                .collect();
            let mut state = ListState::default();
            state.select(Some(selected));
            let list = List::new(items)
                .block(Block::default().borders(Borders::ALL).title("Actions"))
                .highlight_style(Style::default().bg(Color::DarkGray).fg(Color::White).add_modifier(Modifier::BOLD))
                .highlight_symbol("› ");
            frame.render_stateful_widget(list, chunks[1], &mut state);

            let help = Paragraph::new(ACTIONS[selected].help)
                .block(Block::default().borders(Borders::ALL).title("Selected action"))
                .wrap(Wrap { trim: true });
            frame.render_widget(help, chunks[2]);
        })?;

        if event::poll(Duration::from_millis(200))? {
            if let Event::Key(key) = event::read()? {
                match key.code {
                    KeyCode::Char('q') | KeyCode::Esc => {
                        println!("menu");
                        return Ok(());
                    }
                    KeyCode::Char('j') | KeyCode::Down => {
                        selected = (selected + 1) % ACTIONS.len();
                    }
                    KeyCode::Char('k') | KeyCode::Up => {
                        selected = if selected == 0 { ACTIONS.len() - 1 } else { selected - 1 };
                    }
                    KeyCode::Enter => {
                        println!("{}", ACTIONS[selected].key);
                        return Ok(());
                    }
                    _ => {}
                }
            }
        }
    }
}
