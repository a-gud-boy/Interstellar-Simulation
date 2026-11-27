use interstellar_desktop::shaders;

#[test]
fn validate_all_wgsl_shaders_with_naga() {
    let mut validator = naga::valid::Validator::new(
        naga::valid::ValidationFlags::all(),
        naga::valid::Capabilities::all(),
    );

    for (name, source) in shaders::all_named() {
        let module = naga::front::wgsl::parse_str(source).unwrap_or_else(|err| {
            panic!(
                "Shader '{}' failed naga WGSL parse:\n{}",
                name,
                err.emit_to_string(source)
            )
        });
        validator.validate(&module).unwrap_or_else(|err| {
            panic!(
                "Shader '{}' failed naga validation:\n{}",
                name,
                err.emit_to_string(source)
            )
        });
        println!("  [OK naga] {}", name);
    }
}

#[test]
fn validate_all_wgsl_shaders_with_wgpu() {
    let instance = wgpu::Instance::new(wgpu::InstanceDescriptor {
        backends: wgpu::Backends::PRIMARY,
        ..wgpu::InstanceDescriptor::new_without_display_handle()
    });

    let adapter = pollster::block_on(instance.request_adapter(&wgpu::RequestAdapterOptions {
        power_preference: wgpu::PowerPreference::HighPerformance,
        compatible_surface: None,
        force_fallback_adapter: false,
        ..Default::default()
    }))
    .or_else(|_| {
        pollster::block_on(instance.request_adapter(&wgpu::RequestAdapterOptions {
            power_preference: wgpu::PowerPreference::LowPower,
            compatible_surface: None,
            force_fallback_adapter: true,
            ..Default::default()
        }))
    });

    let adapter = match adapter {
        Ok(adapter) => adapter,
        Err(err) => {
            eprintln!(
                "Skipping wgpu runtime shader_validation (no hardware or software adapter available: {err:?}); pure-CPU naga validation already ran."
            );
            return;
        }
    };

    println!("Validating shaders on adapter: {:?}", adapter.get_info());

    let (device, _queue) = pollster::block_on(adapter.request_device(&wgpu::DeviceDescriptor {
        label: Some("shader-validation-device"),
        required_features: wgpu::Features::empty(),
        required_limits: wgpu::Limits::default(),
        memory_hints: wgpu::MemoryHints::Performance,
        trace: wgpu::Trace::Off,
        experimental_features: wgpu::ExperimentalFeatures::disabled(),
    }))
    .expect("Failed to request wgpu device");

    for (name, source) in shaders::all_named() {
        let scope = device.push_error_scope(wgpu::ErrorFilter::Validation);
        let _module = device.create_shader_module(wgpu::ShaderModuleDescriptor {
            label: Some(name),
            source: wgpu::ShaderSource::Wgsl((*source).into()),
        });
        let err = pollster::block_on(scope.pop());
        assert!(
            err.is_none(),
            "Shader '{}' failed wgpu/naga validation: {:?}",
            name,
            err
        );
        println!("  [OK wgpu] {}", name);
    }
}
