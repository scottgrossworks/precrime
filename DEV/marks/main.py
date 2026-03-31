from flask import Flask, request,jsonify
from mark import create_mark


app = Flask(__name__)

@app.route("/create", methods=["POST"])
def create_function():
    return create_mark(request)


@app.route('/ping', methods=['GET'])
def ping_function():
    return jsonify({"status": "ok", "message": "Precrime server is running"})


if __name__ == "__main__":
    app.run(port=8080, debug=True)