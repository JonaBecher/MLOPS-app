import React, {useEffect, useRef, useState} from "react";
import * as tf from "@tensorflow/tfjs";
import "@tensorflow/tfjs-backend-webgl"; // set backend to webgl
import Loader from "./components/loader";
import {Webcam} from "./utils/webcam";
import {renderBoxes} from "./utils/renderBox";
import {non_max_suppression} from "./utils/nonMaxSuppression";
import "./style/App.css";
import useWebSocket from "react-use-websocket";
import labels from "./utils/labels.json";


function shortenedCol(arrayofarray, indexlist) {
  return arrayofarray.map(function (array) {
      return indexlist.map(function (idx) {
          return array[idx];
      });
  });
}
async function getClientId(baseUrl) {
  let requestOptions = {
    method: 'POST',
    redirect: 'follow'
  };
  let data = await fetch(baseUrl + "registerDevice", requestOptions)
  data = await data.json()
  return data.id
}


const App = () => {
  const baseUrl = "https://mlops.mbyt.de/300530342426941322/"
  const websocketUrl = "wss://mlops.mbyt.de/ws/"
  const [loading, setLoading] = useState({ loading: true, progress: 0 });
  const videoRef = useRef(null);
  const canvasRef = useRef(null);
  const webcam = new Webcam();
  // configs
  const threshold = 0.3;
  let model = useRef(null);
  const didUnmount = useRef(false);

  const [socketUrl, setSocketUrl] = useState('');
  const [messageHistory, setMessageHistory] = useState([]);
  const [modelVersion, setModelVersion] = useState(localStorage.getItem("modelId"));
  const [dark, setDark] = useState(false);
  const darkRef = useRef(dark)

  const {  lastMessage, readyState, sendJsonMessage} = useWebSocket(socketUrl,   {
    shouldReconnect: (closeEvent) => {
      /*
      useWebSocket will handle unmounting for you, but this is an example of a
      case in which you would not want it to automatically reconnect
    */
      return didUnmount.current === false;
    },
    reconnectAttempts: 10,
    reconnectInterval: 3000,
  });

  useEffect(() => {
    if (lastMessage !== null) {
      setMessageHistory((prev) => prev.concat(lastMessage));
      if (lastMessage["data"]){
        const raw_data = lastMessage["data"]
        const data = JSON.parse(raw_data)

        switch (data.type) {
          case "modelVersion": {
            sendJsonMessage({"type": "modelVersion", "value": localStorage.getItem("modelId")})
            break;
          }
          case "setDark": {
            console.log("dark")
            setDark(data.value)
            darkRef.current = data.value
            break;
          }
          case "updateModel": {
            localStorage.setItem("modelId", data.value.version)
            tf.loadGraphModel(`${baseUrl}download/${data.value.version}/model.json`).then(async (yolov7) => {
              model.current = yolov7;
              setModelVersion(data.value.version);
              sendJsonMessage({"type": "updateModelVersion", "value": data.value.version})
            })
            break;
          }
        }
      }
    }
  }, [lastMessage, setMessageHistory]);


  const detectFrame = async () => {
    const model_dim = [640, 640];
    tf.engine().startScope();
    const input = tf.tidy(() => {
      console.log(darkRef.current)
      const img = tf.image
                  .resizeBilinear(tf.browser.fromPixels(videoRef.current), model_dim)
                  .mul(darkRef.current?0.04:1)
                  .div(255.0)
                  .transpose([2, 0, 1])
                  .expandDims(0);
      return img
    });
    let res = model.current.execute(input)

    res = res.arraySync()[0];

    let detections = non_max_suppression(res);
    const boxes =  shortenedCol(detections, [0,1,2,3]);
    const scores = shortenedCol(detections, [4]);
    const class_detect = shortenedCol(detections, [5]);

    const meanTensor = tf.mean(input, [2, 3]).mul(255);

    let red = 0
    let green = 0
    let blue = 0

    await meanTensor.array().then(avgValues => {
      [red, green, blue] = avgValues[0];
      console.log(`Average Red: ${red}, Average Green: ${green}, Average Blue: ${blue}`);
    });
    let data = {
      "type": "logs",
      "value": {
        "metrics": [],
        "image": {
          "avgRed": red,
          "avgGreen": green,
          "avgBlue": blue,
        },
        "modelId": localStorage.getItem("modelId"),
        "deviceId": localStorage.getItem("clientId"),
      }
    }

    detections.forEach((detection, idx) => {
      const score = scores[idx][0]
      const detected_class = labels[class_detect[idx]]
      data.value.metrics.push(
          {
            "predictedLabel": detected_class,
            "score": score
      })
      console.log(score, detected_class)
    })
    sendJsonMessage(data)

    renderBoxes(canvasRef, threshold, boxes, scores, class_detect);

    tf.dispose(res);
    function timeout(ms) {
      return new Promise(resolve => setTimeout(resolve, ms));
    }
    await timeout(1000)
    console.log("waited 1sc")
    requestAnimationFrame(() => detectFrame()); // get another frame
    tf.engine().endScope();
  };

  useEffect(async () => {
    setLoading({loading: true, progress: 0});
    let clientId = localStorage.getItem("clientId");
    if (clientId === "null" || clientId === null) {
      clientId = await getClientId(baseUrl);
      localStorage.setItem("clientId", clientId);
      console.log("SET CLIENT ID")
    }
    setSocketUrl(websocketUrl + clientId)
    // baseUrl + `download/model.json`
    const modelId = localStorage.getItem("modelId")
    if (modelId !== "null" || modelId !== null){
      tf.loadGraphModel(`${baseUrl}download/${modelId}/model.json`, {
        onProgress: (fractions) => {
          setLoading({loading: true, progress: fractions});
        },
      }).then(async (yolov7) => {
        // Warmup the model before using real data.
        const dummyInput = tf.ones(yolov7.inputs[0].shape);
        await yolov7.executeAsync(dummyInput).then((warmupResult) => {
          tf.dispose(warmupResult);
          tf.dispose(dummyInput);

          setLoading({loading: false, progress: 1});
          model.current = yolov7
          webcam.open(videoRef, () => detectFrame());
        });
      });
    }
    return () => {
      didUnmount.current = true;
    };
  }, []);

  return (
    <div className="App">
      <h2>Object Detection Using YOLOv7 & Tensorflow.js</h2>
      {loading.loading ? (
        <Loader>Loading model... {(loading.progress * 100).toFixed(2)}%</Loader>
      ) : (
        <p> </p>
      )}

      <div className="content">
        <video style={{filter: dark ? "brightness(20%)": "brightness(100%)"}} autoPlay playsInline muted ref={videoRef} id="frame"/>
        <canvas width={640} height={640} ref={canvasRef} />
      </div>
      <div style={{paddingTop: "10px"}}>Model Version: {modelVersion}</div>
    </div>
  );
};

export default App;
