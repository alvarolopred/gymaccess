const { FaceClient } = require("@azure/cognitiveservices-face");
const { ApiKeyCredentials } = require("@azure/ms-rest-js");
const sql = require('mssql');

// --- CONFIGURACIÓN (Usa Variables de Entorno en Azure) ---
const faceKey = process.env.FACE_API_KEY;
const faceEndPoint = process.env.FACE_API_ENDPOINT;
const personGroupId = "facegym"; // El nombre de tu grupo en Face API

const sqlConfig = {
    user: process.env.SQL_USER,
    password: process.env.SQL_PASSWORD,
    database: process.env.SQL_DATABASE,
    server: process.env.SQL_SERVER, // ejemplo: 'miservidor.database.windows.net'
    pool: { max: 10, min: 0, idleTimeoutMillis: 30000 },
    options: { encrypt: true, trustServerCertificate: false }
};

// Inicializar Face API
const credentials = new ApiKeyCredentials({ inHeader: { 'Ocp-Apim-Subscription-Key': faceKey } });
const faceClient = new FaceClient(credentials, faceEndPoint);

module.exports = async function (context, req) {
    try {
        // 1. Validar que llegue una imagen (binary)
        const imageBuffer = req.body; 
        if (!imageBuffer || imageBuffer.length === 0) {
            context.res = { status: 400, body: "Por favor envía una imagen." };
            return;
        }

        // 2. Face API: Detectar Emoción y Cara
        const detectedFaces = await faceClient.face.detectWithStream(imageBuffer, {
            returnFaceAttributes: ["emotion"],
            recognitionModel: "recognition_04",
            detectionModel: "detection_03"
        });

        if (detectedFaces.length === 0) {
            context.res = { status: 200, body: { mensaje: "No se detectó ninguna cara." } };
            return;
        }

        const faceId = detectedFaces[0].faceId;
        const emociones = detectedFaces[0].faceAttributes.emotion;
        // Obtenemos la emoción predominante (ej: 'happiness')
        const emocionDominante = Object.keys(emociones).reduce((a, b) => emociones[a] > emociones[b] ? a : b);

        // 3. Face API: Identificar (¿Quién es?)
        const identifyResults = await faceClient.face.identify([faceId], {
            personGroupId: personGroupId,
            maxNumOfCandidatesReturned: 1,
            confidenceThreshold: 0.65
        });

        // --- CASO 1: PERSONA DESCONOCIDA (Posible Invitado) ---
        if (identifyResults.length === 0 || identifyResults[0].candidates.length === 0) {
            context.res = {
                status: 200,
                body: {
                    esSocio: false,
                    mensaje: "Usuario no reconocido. ¿Desea registrar como invitado?",
                    emocion: emocionDominante
                }
            };
            return;
        }

        // --- CASO 2: SOCIO IDENTIFICADO ---
        const azurePersonId = identifyResults[0].candidates[0].personId;

        // Conectar a SQL
        const pool = await sql.connect(sqlConfig);

        // A. Buscar al socio en la BBDD local usando el ID de Azure
        const resultSocio = await pool.request()
            .input('azureId', sql.UniqueIdentifier, azurePersonId)
            .query("SELECT SocioID, Nombre FROM Socios WHERE AzurePersonId = @azureId");

        if (resultSocio.recordset.length === 0) {
            context.res = { status: 404, body: "Error: Socio en FaceAPI no encontrado en SQL." };
            return;
        }

        const socio = resultSocio.recordset[0];
        let accionRealizada = "";

        // B. Lógica de Entrada/Salida
        // Buscamos si tiene una sesión abierta (sin fecha de salida)
        const resultAsistencia = await pool.request()
            .input('socioId', sql.Int, socio.SocioID)
            .query("SELECT TOP 1 AsistenciaID FROM Asistencia WHERE SocioID = @socioId AND FechaSalida IS NULL ORDER BY FechaEntrada DESC");

        if (resultAsistencia.recordset.length > 0) {
            // -- SALIDA: Ya estaba dentro, cerramos la sesión --
            const asistenciaId = resultAsistencia.recordset[0].AsistenciaID;
            await pool.request()
                .input('id', sql.Int, asistenciaId)
                .input('emocion', sql.NVarChar, emocionDominante)
                .query("UPDATE Asistencia SET FechaSalida = GETDATE(), EmocionSalida = @emocion WHERE AsistenciaID = @id");
            
            accionRealizada = `Adiós ${socio.Nombre}. Emoción salida: ${emocionDominante}`;

        } else {
            // -- ENTRADA: No estaba dentro, creamos nuevo registro --
            // Aquí podrías recibir 'salaID' desde el frontend si hay varias cámaras
            const salaDefecto = 1; // ID de la sala de recepción o musculación
            
            await pool.request()
                .input('socioId', sql.Int, socio.SocioID)
                .input('salaId', sql.Int, salaDefecto)
                .input('emocion', sql.NVarChar, emocionDominante)
                .query("INSERT INTO Asistencia (SocioID, SalaID, EsInvitado, FechaEntrada, EmocionEntrada) VALUES (@socioId, @salaId, 0, GETDATE(), @emocion)");
            
            accionRealizada = `Bienvenido ${socio.Nombre}. Emoción entrada: ${emocionDominante}`;
        }

        context.res = {
            status: 200,
            body: {
                esSocio: true,
                nombre: socio.Nombre,
                mensaje: accionRealizada,
                emocion: emocionDominante
            }
        };

    } catch (err) {
        context.log(err);
        context.res = { status: 500, body: "Error interno: " + err.message };
    }
};