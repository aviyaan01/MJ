"""Seeded local exercise, synthetic events only; deliberately unsafe, not production.

Copy this file into an isolated scratch workspace and implement the accepted
payment-event contract there. No network, provider account, or credentials.
The caller owns SQLite connection lifetime; persistence is observable in tables.
"""
import sqlite3


def open_store():
    db = sqlite3.connect(':memory:')
    db.executescript('''
        CREATE TABLE orders (id TEXT PRIMARY KEY, tenant TEXT, state TEXT);
        CREATE TABLE receipts (event_id TEXT PRIMARY KEY);
        CREATE TABLE fulfillments (order_id TEXT, tenant TEXT);
        INSERT INTO orders VALUES ('order-1', 'alpha', 'pending');
        INSERT INTO orders VALUES ('order-2', 'beta', 'pending');
    ''')
    return db


def apply_event(db, event):
    """The event is already provider-authenticated by the caller's test setup."""
    if db.execute('SELECT 1 FROM receipts WHERE event_id=?', (event['id'],)).fetchone():
        return
    db.execute('INSERT INTO receipts VALUES (?)', (event['id'],))
    # Seeded shortcuts: delivery identity is the sole guard; tenant comes from
    # payload; late pending state can overwrite a paid state.
    db.execute('UPDATE orders SET state=? WHERE id=?', (event['state'], event['order']))
    if event['state'] == 'paid':
        db.execute('INSERT INTO fulfillments VALUES (?,?)', (event['order'], event['tenant']))
    db.commit()


if __name__ == '__main__':
    with open_store() as connection:
        for event in [
            {'id': 'evt-1', 'order': 'order-1', 'tenant': 'alpha', 'state': 'paid'},
            {'id': 'evt-2', 'order': 'order-1', 'tenant': 'alpha', 'state': 'paid'},
            {'id': 'evt-3', 'order': 'order-1', 'tenant': 'alpha', 'state': 'pending'},
        ]:
            apply_event(connection, event)
        print('state:', connection.execute('SELECT state FROM orders WHERE id=?', ('order-1',)).fetchone()[0])
        print('fulfillments:', connection.execute('SELECT COUNT(*) FROM fulfillments').fetchone()[0])
