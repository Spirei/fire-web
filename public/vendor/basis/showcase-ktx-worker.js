// Generated from Three.js KTX2Loader.BasisWorker; do not edit by hand.
let _EngineFormat = {"RGBAFormat":1023,"RGBA_ASTC_4x4_Format":37808,"RGB_BPTC_UNSIGNED_Format":36495,"RGBA_BPTC_Format":36492,"RGBA_ETC2_EAC_Format":37496,"RGBA_PVRTC_4BPPV1_Format":35842,"RGBA_S3TC_DXT5_Format":33779,"RGB_ETC1_Format":36196,"RGB_ETC2_Format":37492,"RGB_PVRTC_4BPPV1_Format":35840,"RGBA_S3TC_DXT1_Format":33777};
let _EngineType = {"UnsignedByteType":1009,"HalfFloatType":1016,"FloatType":1015};
let _TranscoderFormat = {"ETC1":0,"ETC2":1,"BC1":2,"BC3":3,"BC4":4,"BC5":5,"BC7_M6_OPAQUE_ONLY":6,"BC7_M5":7,"PVRTC1_4_RGB":8,"PVRTC1_4_RGBA":9,"ASTC_4x4":10,"ATC_RGB":11,"ATC_RGBA_INTERPOLATED_ALPHA":12,"RGBA32":13,"RGB565":14,"BGR565":15,"RGBA4444":16,"BC6H":22,"RGB_HALF":24,"RGBA_HALF":25};
let _BasisFormat = {"ETC1S":0,"UASTC":1,"UASTC_HDR":2};
importScripts('/vendor/basis/basis_transcoder.js');
let config;
	let transcoderPending;
	let BasisModule;

	const EngineFormat = _EngineFormat; // eslint-disable-line no-undef
	const EngineType = _EngineType; // eslint-disable-line no-undef
	const TranscoderFormat = _TranscoderFormat; // eslint-disable-line no-undef
	const BasisFormat = _BasisFormat; // eslint-disable-line no-undef

	self.addEventListener( 'message', function ( e ) {

		const message = e.data;

		switch ( message.type ) {

			case 'init':
				config = message.config;
				init( message.transcoderBinary );
				break;

			case 'transcode':
				transcoderPending.then( () => {

					try {

						const { faces, buffers, width, height, hasAlpha, format, type, dfdFlags } = transcode( message.buffer );

						self.postMessage( { type: 'transcode', id: message.id, data: { faces, width, height, hasAlpha, format, type, dfdFlags } }, buffers );

					} catch ( error ) {

						console.error( error );

						self.postMessage( { type: 'error', id: message.id, error: error.message } );

					}

				} );
				break;

		}

	} );

	function init( wasmBinary ) {

		transcoderPending = new Promise( ( resolve ) => {

			BasisModule = { wasmBinary, onRuntimeInitialized: resolve };
			BASIS( BasisModule ); // eslint-disable-line no-undef

		} ).then( () => {

			BasisModule.initializeBasis();

			if ( BasisModule.KTX2File === undefined ) {

				console.warn( 'THREE.KTX2Loader: Please update Basis Universal transcoder.' );

			}

		} );

	}

	function transcode( buffer ) {

		const ktx2File = new BasisModule.KTX2File( new Uint8Array( buffer ) );

		function cleanup() {

			ktx2File.close();
			ktx2File.delete();

		}

		if ( ! ktx2File.isValid() ) {

			cleanup();
			throw new Error( 'THREE.KTX2Loader:	Invalid or unsupported .ktx2 file' );

		}

		let basisFormat;

		if ( ktx2File.isUASTC() ) {

			basisFormat = BasisFormat.UASTC;

		} else if ( ktx2File.isETC1S() ) {

			basisFormat = BasisFormat.ETC1S;

		} else if ( ktx2File.isHDR() ) {

			basisFormat = BasisFormat.UASTC_HDR;

		} else {

			throw new Error( 'THREE.KTX2Loader: Unknown Basis encoding' );

		}

		const width = ktx2File.getWidth();
		const height = ktx2File.getHeight();
		const layerCount = ktx2File.getLayers() || 1;
		const levelCount = ktx2File.getLevels();
		const faceCount = ktx2File.getFaces();
		const hasAlpha = ktx2File.getHasAlpha();
		const dfdFlags = ktx2File.getDFDFlags();

		const { transcoderFormat, engineFormat, engineType } = getTranscoderFormat( basisFormat, width, height, hasAlpha );

		if ( ! width || ! height || ! levelCount ) {

			cleanup();
			throw new Error( 'THREE.KTX2Loader:	Invalid texture' );

		}

		if ( ! ktx2File.startTranscoding() ) {

			cleanup();
			throw new Error( 'THREE.KTX2Loader: .startTranscoding failed' );

		}

		const faces = [];
		const buffers = [];

		for ( let face = 0; face < faceCount; face ++ ) {

			const mipmaps = [];

			for ( let mip = 0; mip < levelCount; mip ++ ) {

				const layerMips = [];

				let mipWidth, mipHeight;

				for ( let layer = 0; layer < layerCount; layer ++ ) {

					const levelInfo = ktx2File.getImageLevelInfo( mip, layer, face );

					if ( face === 0 && mip === 0 && layer === 0 && ( levelInfo.origWidth % 4 !== 0 || levelInfo.origHeight % 4 !== 0 ) ) {

						console.warn( 'THREE.KTX2Loader: ETC1S and UASTC textures should use multiple-of-four dimensions.' );

					}

					if ( levelCount > 1 ) {

						mipWidth = levelInfo.origWidth;
						mipHeight = levelInfo.origHeight;

					} else {

						// Handles non-multiple-of-four dimensions in textures without mipmaps. Textures with
						// mipmaps must use multiple-of-four dimensions, for some texture formats and APIs.
						// See mrdoob/three.js#25908.
						mipWidth = levelInfo.width;
						mipHeight = levelInfo.height;

					}

					let dst = new Uint8Array( ktx2File.getImageTranscodedSizeInBytes( mip, layer, 0, transcoderFormat ) );
					const status = ktx2File.transcodeImage( dst, mip, layer, face, transcoderFormat, 0, - 1, - 1 );

					if ( engineType === EngineType.HalfFloatType ) {

						dst = new Uint16Array( dst.buffer, dst.byteOffset, dst.byteLength / Uint16Array.BYTES_PER_ELEMENT );

					}

					if ( ! status ) {

						cleanup();
						throw new Error( 'THREE.KTX2Loader: .transcodeImage failed.' );

					}

					layerMips.push( dst );

				}

				const mipData = concat( layerMips );

				mipmaps.push( { data: mipData, width: mipWidth, height: mipHeight } );
				buffers.push( mipData.buffer );

			}

			faces.push( { mipmaps, width, height, format: engineFormat, type: engineType } );

		}

		cleanup();

		return { faces, buffers, width, height, hasAlpha, dfdFlags, format: engineFormat, type: engineType };

	}

	//

	// Optimal choice of a transcoder target format depends on the Basis format (ETC1S, UASTC, or
	// UASTC HDR), device capabilities, and texture dimensions. The list below ranks the formats
	// separately for each format. Currently, priority is assigned based on:
	//
	//   high quality > low quality > uncompressed
	//
	// Prioritization may be revisited, or exposed for configuration, in the future.
	//
	// Reference: https://github.com/KhronosGroup/3D-Formats-Guidelines/blob/main/KTXDeveloperGuide.md
	const FORMAT_OPTIONS = [
		{
			if: 'astcSupported',
			basisFormat: [ BasisFormat.UASTC ],
			transcoderFormat: [ TranscoderFormat.ASTC_4x4, TranscoderFormat.ASTC_4x4 ],
			engineFormat: [ EngineFormat.RGBA_ASTC_4x4_Format, EngineFormat.RGBA_ASTC_4x4_Format ],
			engineType: [ EngineType.UnsignedByteType ],
			priorityETC1S: Infinity,
			priorityUASTC: 1,
			needsPowerOfTwo: false,
		},
		{
			if: 'bptcSupported',
			basisFormat: [ BasisFormat.ETC1S, BasisFormat.UASTC ],
			transcoderFormat: [ TranscoderFormat.BC7_M5, TranscoderFormat.BC7_M5 ],
			engineFormat: [ EngineFormat.RGBA_BPTC_Format, EngineFormat.RGBA_BPTC_Format ],
			engineType: [ EngineType.UnsignedByteType ],
			priorityETC1S: 3,
			priorityUASTC: 2,
			needsPowerOfTwo: false,
		},
		{
			if: 'dxtSupported',
			basisFormat: [ BasisFormat.ETC1S, BasisFormat.UASTC ],
			transcoderFormat: [ TranscoderFormat.BC1, TranscoderFormat.BC3 ],
			engineFormat: [ EngineFormat.RGBA_S3TC_DXT1_Format, EngineFormat.RGBA_S3TC_DXT5_Format ],
			engineType: [ EngineType.UnsignedByteType ],
			priorityETC1S: 4,
			priorityUASTC: 5,
			needsPowerOfTwo: false,
		},
		{
			if: 'etc2Supported',
			basisFormat: [ BasisFormat.ETC1S, BasisFormat.UASTC ],
			transcoderFormat: [ TranscoderFormat.ETC1, TranscoderFormat.ETC2 ],
			engineFormat: [ EngineFormat.RGB_ETC2_Format, EngineFormat.RGBA_ETC2_EAC_Format ],
			engineType: [ EngineType.UnsignedByteType ],
			priorityETC1S: 1,
			priorityUASTC: 3,
			needsPowerOfTwo: false,
		},
		{
			if: 'etc1Supported',
			basisFormat: [ BasisFormat.ETC1S, BasisFormat.UASTC ],
			transcoderFormat: [ TranscoderFormat.ETC1 ],
			engineFormat: [ EngineFormat.RGB_ETC1_Format ],
			engineType: [ EngineType.UnsignedByteType ],
			priorityETC1S: 2,
			priorityUASTC: 4,
			needsPowerOfTwo: false,
		},
		{
			if: 'pvrtcSupported',
			basisFormat: [ BasisFormat.ETC1S, BasisFormat.UASTC ],
			transcoderFormat: [ TranscoderFormat.PVRTC1_4_RGB, TranscoderFormat.PVRTC1_4_RGBA ],
			engineFormat: [ EngineFormat.RGB_PVRTC_4BPPV1_Format, EngineFormat.RGBA_PVRTC_4BPPV1_Format ],
			engineType: [ EngineType.UnsignedByteType ],
			priorityETC1S: 5,
			priorityUASTC: 6,
			needsPowerOfTwo: true,
		},
		{
			if: 'bptcSupported',
			basisFormat: [ BasisFormat.UASTC_HDR ],
			transcoderFormat: [ TranscoderFormat.BC6H ],
			engineFormat: [ EngineFormat.RGB_BPTC_UNSIGNED_Format ],
			engineType: [ EngineType.HalfFloatType ],
			priorityHDR: 1,
			needsPowerOfTwo: false,
		},

		// Uncompressed fallbacks.

		{
			basisFormat: [ BasisFormat.ETC1S, BasisFormat.UASTC ],
			transcoderFormat: [ TranscoderFormat.RGBA32, TranscoderFormat.RGBA32 ],
			engineFormat: [ EngineFormat.RGBAFormat, EngineFormat.RGBAFormat ],
			engineType: [ EngineType.UnsignedByteType, EngineType.UnsignedByteType ],
			priorityETC1S: 100,
			priorityUASTC: 100,
			needsPowerOfTwo: false,
		},
		{
			basisFormat: [ BasisFormat.UASTC_HDR ],
			transcoderFormat: [ TranscoderFormat.RGBA_HALF ],
			engineFormat: [ EngineFormat.RGBAFormat ],
			engineType: [ EngineType.HalfFloatType ],
			priorityHDR: 100,
			needsPowerOfTwo: false,
		}
	];

	const OPTIONS = {
		// TODO: For ETC1S we intentionally sort by _UASTC_ priority, preserving
		// a historical accident shown to avoid performance pitfalls for Linux with
		// Firefox & AMD GPU (RadeonSI). Further work needed.
		// See https://github.com/mrdoob/three.js/pull/29730.
		[ BasisFormat.ETC1S ]: FORMAT_OPTIONS
			.filter( ( opt ) => opt.basisFormat.includes( BasisFormat.ETC1S ) )
			.sort( ( a, b ) => a.priorityUASTC - b.priorityUASTC ),

		[ BasisFormat.UASTC ]: FORMAT_OPTIONS
			.filter( ( opt ) => opt.basisFormat.includes( BasisFormat.UASTC ) )
			.sort( ( a, b ) => a.priorityUASTC - b.priorityUASTC ),

		[ BasisFormat.UASTC_HDR ]: FORMAT_OPTIONS
			.filter( ( opt ) => opt.basisFormat.includes( BasisFormat.UASTC_HDR ) )
			.sort( ( a, b ) => a.priorityHDR - b.priorityHDR ),
	};

	function getTranscoderFormat( basisFormat, width, height, hasAlpha ) {

		const options = OPTIONS[ basisFormat ];

		for ( let i = 0; i < options.length; i ++ ) {

			const opt = options[ i ];

			if ( opt.if && ! config[ opt.if ] ) continue;
			if ( ! opt.basisFormat.includes( basisFormat ) ) continue;
			if ( hasAlpha && opt.transcoderFormat.length < 2 ) continue;
			if ( opt.needsPowerOfTwo && ! ( isPowerOfTwo( width ) && isPowerOfTwo( height ) ) ) continue;

			const transcoderFormat = opt.transcoderFormat[ hasAlpha ? 1 : 0 ];
			const engineFormat = opt.engineFormat[ hasAlpha ? 1 : 0 ];
			const engineType = opt.engineType[ 0 ];

			return { transcoderFormat, engineFormat, engineType };

		}

		throw new Error( 'THREE.KTX2Loader: Failed to identify transcoding target.' );

	}

	function isPowerOfTwo( value ) {

		if ( value <= 2 ) return true;

		return ( value & ( value - 1 ) ) === 0 && value !== 0;

	}

	/**
	 * Concatenates N byte arrays.
	 *
	 * @param {Uint8Array[]} arrays
	 * @return {Uint8Array}
	 */
	function concat( arrays ) {

		if ( arrays.length === 1 ) return arrays[ 0 ];

		let totalByteLength = 0;

		for ( let i = 0; i < arrays.length; i ++ ) {

			const array = arrays[ i ];
			totalByteLength += array.byteLength;

		}

		const result = new Uint8Array( totalByteLength );

		let byteOffset = 0;

		for ( let i = 0; i < arrays.length; i ++ ) {

			const array = arrays[ i ];
			result.set( array, byteOffset );

			byteOffset += array.byteLength;

		}

		return result;

	}
