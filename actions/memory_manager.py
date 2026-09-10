import os
import json
import uuid
import datetime

MEMORY_FILE = "config/memory.json"

def _load_memory() -> dict:
    if not os.path.exists("config"):
        os.makedirs("config", exist_ok=True)
    if not os.path.exists(MEMORY_FILE):
        return {"facts": []}
    
    try:
        with open(MEMORY_FILE, "r", encoding="utf-8") as f:
            return json.load(f)
    except Exception:
        return {"facts": []}

def _save_memory(data: dict) -> None:
    if not os.path.exists("config"):
        os.makedirs("config", exist_ok=True)
    with open(MEMORY_FILE, "w", encoding="utf-8") as f:
        json.dump(data, f, indent=4)

async def handle_remember_fact(app, args: dict, loop) -> dict:
    """Saves a new fact into MJ's long-term memory."""
    fact = args.get("fact")
    category = args.get("category", "general")
    
    if not fact:
        app.ui.write_log("MEM: Missing fact to remember.")
        return {"status": "error", "message": "Missing fact"}

    data = _load_memory()
    new_fact = {
        "id": str(uuid.uuid4())[:8],
        "category": category,
        "fact": fact,
        "timestamp": datetime.datetime.now().isoformat()
    }
    data["facts"].append(new_fact)
    _save_memory(data)
    
    app.ui.write_log(f"MEM: Remembered -> [{category}] {fact}")
    return {"status": "success", "id": new_fact["id"]}

async def handle_recall_facts(app, args: dict, loop) -> dict:
    """Searches memory for facts matching a query or category."""
    query = args.get("query", "").lower()
    category = args.get("category", "").lower()
    
    data = _load_memory()
    results = []
    
    for f in data["facts"]:
        f_cat = f.get("category", "").lower()
        f_text = f.get("fact", "").lower()
        
        if query and query not in f_text and query not in f_cat:
            continue
        if category and category != f_cat:
            continue
            
        results.append(f)
        
    if not results:
        app.ui.write_log(f"MEM: No memories found for query '{query}'.")
        return {"results": "No facts found."}
    
    app.ui.write_log(f"MEM: Recalled {len(results)} facts.")
    return {"results": results}

async def handle_forget_fact(app, args: dict, loop) -> dict:
    """Deletes a fact by ID."""
    fact_id = args.get("fact_id")
    if not fact_id:
        return {"status": "error", "message": "Missing fact_id"}
        
    data = _load_memory()
    original_len = len(data["facts"])
    data["facts"] = [f for f in data["facts"] if f.get("id") != fact_id]
    
    if len(data["facts"]) < original_len:
        _save_memory(data)
        app.ui.write_log(f"MEM: Forgot fact ID {fact_id}.")
        return {"status": "success", "message": f"Fact {fact_id} deleted."}
    else:
        return {"status": "error", "message": f"Fact ID {fact_id} not found."}

def get_core_memory_summary() -> str:
    """Returns a string summarizing all memories for system prompt injection."""
    data = _load_memory()
    if not data["facts"]:
        return "No long-term memories saved yet."
        
    lines = ["Here are facts you have learned and MUST remember about the user:"]
    for f in data["facts"]:
        lines.append(f"- [{f.get('category', 'general')}] (ID: {f.get('id')}) {f.get('fact')}")
    return "\n".join(lines)
