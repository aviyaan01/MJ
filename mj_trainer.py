import json
import os
import sys
from datasets import load_dataset

# Fix Windows console UTF-8 output encoding
if hasattr(sys.stdout, "reconfigure"):
    try:
        sys.stdout.reconfigure(encoding="utf-8")
    except Exception:
        pass


def setup_mj_agent():
    print("1. Hugging Face theke Jedi dataset streaming mode-e load kora hocche...")
    output_file = "jedi_training_data.jsonl"

    try:
        # streaming=True bebohar korle pura 150k+ dataset download korte hoy na ebong schema CastError hoy na
        dataset = load_dataset("xlangai/Jedi", streaming=True, split="train")

        print("2. Prothom 50-ti entry JSONL format-e save kora hocche...")
        items = list(dataset.take(50))

        with open(output_file, "w", encoding="utf-8") as file:
            for row in items:
                file.write(json.dumps(row, ensure_ascii=False) + "\n")

        print(f"[OK] Data save hoyeche: {output_file} ({len(items)} samples)")

    except Exception as e:
        print(f"[ERROR] Dataset load korte error: {e}")

    print("\n3. Ollama-r jonne custom Modelfile toiri kora hocche...")
    # Apnar PC-te already thaka llama3.2 bebohar kora hocche jate notun kore download na lage
    modelfile_content = """FROM llama3.2

PARAMETER temperature 0.3
PARAMETER top_p 0.9

SYSTEM \"\"\"Tumi MJ (ULTRON), ekjon advanced desktop assistant.
Tomar kaj hocche user-er command bujhe background-e OS automation ebong terminal command execute kora.
Proyojone pyautogui ba os/subprocess library-r code output dibe.\"\"\"
"""
    with open("Modelfile", "w", encoding="utf-8") as f:
        f.write(modelfile_content)

    print("[OK] Modelfile toiri hoyeche: Modelfile")
    print("\nEkhon terminal-e nicher command-ti run koro custom model toiri korte:")
    print("ollama create mj-os-agent -f Modelfile")
    print("\n[OK] Step 3: build_mj_full_prompt() function toiri ache — dynamic few-shot prompter jonne ready!")


def build_mj_full_prompt(user_command: str, master_prompt: str, jsonl_path: str = "jedi_training_data.jsonl") -> str:
    """
    Step 3: Jedi Dataset dynamic few-shot prompt builder.
    Jedi dataset theke prothom 3-ti example load kore Master Prompt + Reference Examples + User Command ekshathe jora dewa.
    """
    examples = []
    target_path = jsonl_path
    if not os.path.exists(target_path):
        base_cand = os.path.join(os.path.dirname(os.path.abspath(__file__)), jsonl_path)
        if os.path.exists(base_cand):
            target_path = base_cand

    try:
        with open(target_path, "r", encoding="utf-8") as f:
            for i in range(3):
                line = f.readline()
                if line:
                    examples.append(line.strip())
    except FileNotFoundError:
        pass

    dataset_context = "\n".join(examples)

    # Master Prompt + Jedi Dataset Reference + User Command ekshathe jora dewa
    final_prompt = f"""{master_prompt}

### REFERENCE OS INTERACTION EXAMPLES (FROM JEDI DATASET):
{dataset_context}

### CURRENT USER COMMAND:
"{user_command}"

Respond with your step-by-step plan and execute the required tool calls:"""

    return final_prompt


if __name__ == "__main__":
    setup_mj_agent()