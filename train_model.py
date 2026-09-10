import os
import subprocess
import zipfile
import pandas as pd
from sklearn.model_selection import train_test_split
from sklearn.ensemble import RandomForestClassifier
from sklearn.metrics import accuracy_score

def train():
    # 1. Download dataset from Kaggle (Titanic dataset)
    print("Downloading dataset from Kaggle...")
    subprocess.run(['kaggle', 'competitions', 'download', '-c', 'titanic', '-p', './titanic_data'], check=False)

    # 2. Extract the downloaded zip file
    zip_path = './titanic_data/titanic.zip'
    if os.path.exists(zip_path):
        with zipfile.ZipFile(zip_path, 'r') as zip_ref:
            zip_ref.extractall('./titanic_data')
        print("Dataset extracted!")

    # 3. Load the data
    print("Loading data...")
    try:
        train_data = pd.read_csv('./titanic_data/train.csv')
    except FileNotFoundError:
        print("Error: train.csv not found! Ensure kaggle.json is correctly placed and API is working.")
        exit(1)

    # 4. Basic Data Cleaning
    train_data['Age'] = train_data['Age'].fillna(train_data['Age'].median())
    train_data['Sex'] = train_data['Sex'].replace({'male': 0, 'female': 1})

    # 5. Separate features (X) and target (y)
    X = train_data[['Pclass', 'Sex', 'Age', 'Fare']]
    y = train_data['Survived']

    # 6. Split into training and testing sets
    X_train, X_test, y_train, y_test = train_test_split(X, y, test_size=0.2, random_state=42)

    # 7. Train the model
    print("Training Random Forest model...")
    model = RandomForestClassifier(n_estimators=100, random_state=42)
    model.fit(X_train, y_train)

    # 8. Test model accuracy
    predictions = model.predict(X_test)
    accuracy = accuracy_score(y_test, predictions)
    print(f"Model Training Complete! Accuracy: {accuracy * 100:.2f}%")


if __name__ == "__main__":
    train()
